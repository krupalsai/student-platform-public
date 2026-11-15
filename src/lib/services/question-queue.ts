import { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/embeddings";
import { answerUnknownQuestion } from "@/lib/services/faq";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { deliverAnswerToAppThreads } from "@/lib/services/support-cases";

/**
 * Open-Question Queue — groups PENDING unknown questions by meaning so an admin
 * can answer a whole cluster of differently-worded-but-same questions once.
 * Read-only w.r.t. business data except: it fills in question embeddings, marks
 * questions answered, creates the FAQ, and messages the students who asked.
 */

const CLUSTER_THRESHOLD = Number(process.env.QUESTION_CLUSTER_THRESHOLD ?? 0.82);

export interface QueueQuestion {
  id: string;
  shortId: number | null;
  question: string;
  occurrences: number;
  phone: string | null;
  lastSeenAt: string | null;
}
export interface QuestionCluster {
  ids: string[];
  totalOccurrences: number;
  questions: QueueQuestion[];
}

/** pgvector comes back from PostgREST as a "[0.1,0.2,...]" string (or array). */
export function parseEmbedding(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * Returns pending questions grouped into semantic clusters (most-asked first).
 * Lazily embeds any pending question missing an embedding and stores it, so
 * the next call is fast. When embeddings are unavailable, every question is its
 * own single-item cluster (the queue still works, just ungrouped).
 */
export async function getPendingQuestionClusters(db: SupabaseClient): Promise<QuestionCluster[]> {
  const { data } = await db
    .from("unknown_questions")
    .select("id, short_id, question, occurrence_count, student_phone, last_seen_at, embedding")
    .eq("status", "pending")
    .order("occurrence_count", { ascending: false })
    .order("last_seen_at", { ascending: false });

  const rows = (data ?? []) as any[];

  // Lazily backfill embeddings for pending questions that don't have one.
  const withEmb: Array<{ q: QueueQuestion; emb: number[] | null }> = [];
  for (const r of rows) {
    let emb = parseEmbedding(r.embedding);
    if (!emb) {
      const computed = await embedText(r.question);
      if (computed) {
        await db.from("unknown_questions").update({ embedding: computed }).eq("id", r.id);
        emb = computed;
      }
    }
    withEmb.push({
      emb,
      q: {
        id: r.id, shortId: r.short_id ?? null, question: r.question,
        occurrences: r.occurrence_count ?? 1, phone: r.student_phone ?? null,
        lastSeenAt: r.last_seen_at ?? null,
      },
    });
  }

  // Greedy clustering by cosine similarity. Questions without an embedding
  // (embeddings unconfigured) never merge — they stay as their own cluster.
  const clusters: Array<{ centroid: number[] | null; items: QueueQuestion[] }> = [];
  for (const { q, emb } of withEmb) {
    let placed = false;
    if (emb) {
      for (const cl of clusters) {
        if (cl.centroid && cosine(emb, cl.centroid) >= CLUSTER_THRESHOLD) {
          cl.items.push(q); placed = true; break;
        }
      }
    }
    if (!placed) clusters.push({ centroid: emb, items: [q] });
  }

  return clusters
    .map(c => ({
      ids: c.items.map(i => i.id),
      questions: c.items,
      totalOccurrences: c.items.reduce((s, i) => s + i.occurrences, 0),
    }))
    .sort((a, b) => b.totalOccurrences - a.totalOccurrences);
}

/**
 * Answers a cluster of questions with a single answer: creates ONE FAQ from the
 * representative (first) question, marks every question in the cluster
 * answered, and messages each student who asked (WhatsApp, best-effort).
 */
export async function answerQuestionCluster(
  db: SupabaseClient,
  ids: string[],
  answer: string,
  answeredBy: string,
): Promise<{ answered: number; faqId: string | null; notified: number }> {
  if (!ids.length) return { answered: 0, faqId: null, notified: 0 };

  // Representative question → the real FAQ (auto-keyworded + embedded).
  const faq = await answerUnknownQuestion(db, ids[0], answer);

  // Load the rest so we can mark them answered + notify their askers.
  const { data: rows } = await db
    .from("unknown_questions")
    .select("id, question, student_phone")
    .in("id", ids)
    .eq("status", "pending");

  const nowIso = new Date().toISOString();
  const remaining = (rows ?? []).filter((r: any) => r.id !== ids[0]);
  if (remaining.length) {
    await db.from("unknown_questions")
      .update({ status: "answered", faq_id: faq?.faqId ?? null, answered_by: answeredBy, answered_at: nowIso })
      .in("id", remaining.map((r: any) => r.id))
      .eq("status", "pending");
  }

  // Notify every asker in the cluster (including the representative).
  let notified = 0;
  const askers = (rows ?? []) as Array<{ id: string; question: string; student_phone: string | null }>;
  await Promise.all(askers.map(async r => {
    if (!r.student_phone) return;
    const okSent = await sendWhatsAppText(
      r.student_phone,
      `Hi! We have an answer to your question:\n\n"${r.question}"\n\n${answer}`,
    ).catch(() => false);
    if (okSent) notified++;
  }));

  // Students who asked inside the Student App get it in their own thread too.
  notified += await deliverAnswerToAppThreads(db, ids, answer, /^[0-9a-f-]{36}$/i.test(answeredBy) ? answeredBy : null);

  return { answered: (rows ?? []).length, faqId: faq?.faqId ?? null, notified };
}
