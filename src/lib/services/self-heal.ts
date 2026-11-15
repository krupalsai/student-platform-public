import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/embeddings";
import { parseEmbedding } from "@/lib/services/question-queue";
import { deliverAnswerToAppThreads } from "@/lib/services/support-cases";

/**
 * Self-fix actions run by /api/cron/self-watch. Each one is small, bounded
 * per run, and safe to automate because it only does what an admin would
 * have done by hand with the same information:
 *
 *   - autoAnswerFromExistingFaqs: a waiting student question that an
 *     existing (admin-approved) FAQ already answers is answered with that
 *     FAQ, and the answer is delivered into the student's in-app thread.
 *   - maybeAutoRollback: if the live site has been down on two consecutive
 *     checks right after a new deploy, production is pointed back at the
 *     previous working deployment.
 *
 * Code itself is never changed here.
 */

/**
 * Stricter than the live search (FAQ_SEMANTIC_THRESHOLD, 0.75): answering
 * without anyone asking again should only happen on a near-identical question.
 */
const AUTO_ANSWER_THRESHOLD = Number(process.env.SELF_HEAL_FAQ_THRESHOLD ?? 0.88);

export async function autoAnswerFromExistingFaqs(
  db: SupabaseClient,
  opts: { limit?: number; maxNewEmbeddings?: number } = {},
): Promise<{ checked: number; answered: number }> {
  const out = { checked: 0, answered: 0 };
  const { data: rows, error } = await db
    .from("unknown_questions")
    .select("id, question, embedding")
    .eq("status", "pending")
    .order("last_seen_at", { ascending: false })
    .limit(opts.limit ?? 40);
  if (error || !rows?.length) return out;

  // Embeddings share a free-tier quota with the live assistant, so only a few
  // missing ones are computed per run; the rest are picked up on later runs.
  let newEmbeddings = 0;
  const maxNew = opts.maxNewEmbeddings ?? 5;

  for (const r of rows as Array<{ id: string; question: string; embedding: unknown }>) {
    let emb = parseEmbedding(r.embedding);
    if (!emb) {
      if (newEmbeddings >= maxNew) continue;
      newEmbeddings++;
      emb = await embedText(r.question).catch(() => null);
      if (!emb) continue;
      await db.from("unknown_questions").update({ embedding: emb }).eq("id", r.id);
    }
    out.checked++;

    const { data: match, error: mErr } = await db.rpc("match_faqs", {
      query_embedding: emb,
      match_threshold: AUTO_ANSWER_THRESHOLD,
      match_count: 1,
    });
    const faq = !mErr && match?.length ? (match[0] as { id: string; answer: string }) : null;
    if (!faq?.answer) continue;

    const { data: updated } = await db
      .from("unknown_questions")
      .update({ status: "answered", faq_id: faq.id, answered_by: "auto:existing-faq", answered_at: new Date().toISOString() })
      .eq("id", r.id)
      .eq("status", "pending")
      .select("id");
    if (!updated?.length) continue; // someone answered it meanwhile
    out.answered++;
    await deliverAnswerToAppThreads(db, [r.id], faq.answer);
  }
  return out;
}

const VERCEL_API = "https://api.vercel.com";
/** Only a deploy this recent is a plausible cause of an outage worth undoing. */
const RECENT_DEPLOY_MS = 24 * 3_600_000;

export interface RollbackResult {
  attempted: boolean;
  rolledBackTo?: string;
  from?: string;
  reason: string;
}

/**
 * Points production back at the previous READY production deployment.
 * Called only after the homepage failed on two consecutive self-watch runs.
 * Inert without VERCEL_TOKEN/VERCEL_PROJECT_ID. Never rolls back past a
 * deployment older than 24h — an outage with no recent deploy is not a
 * code problem a rollback would fix.
 */
export async function maybeAutoRollback(): Promise<RollbackResult> {
  const token = (process.env.VERCEL_TOKEN ?? "").trim();
  const projectId = (process.env.VERCEL_PROJECT_ID ?? "").trim();
  const teamId = (process.env.VERCEL_TEAM_ID ?? "").trim();
  if (!token || !projectId) return { attempted: false, reason: "VERCEL_TOKEN / VERCEL_PROJECT_ID not configured" };

  const team = teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const res = await fetch(
      `${VERCEL_API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&state=READY&limit=5${team}`,
      { headers, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return { attempted: false, reason: `could not list deployments (HTTP ${res.status})` };
    const deployments = ((await res.json())?.deployments ?? []) as Array<{ uid: string; created: number }>;
    const [current, previous] = deployments;
    if (!current || !previous) return { attempted: false, reason: "no earlier working deployment to roll back to" };
    if (Date.now() - current.created > RECENT_DEPLOY_MS) {
      return { attempted: false, reason: "no deploy in the last 24h — a rollback would not fix this" };
    }

    const description = encodeURIComponent("Automatic rollback: site down on consecutive self-watch checks");
    const rb = await fetch(
      `${VERCEL_API}/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(previous.uid)}?description=${description}${team}`,
      { method: "POST", headers, signal: AbortSignal.timeout(15000) },
    );
    if (!rb.ok) return { attempted: true, reason: `rollback request failed (HTTP ${rb.status})` };
    return { attempted: true, rolledBackTo: previous.uid, from: current.uid, reason: "rolled back" };
  } catch (e) {
    return { attempted: false, reason: `Vercel API error: ${(e as Error).message}` };
  }
}

/**
 * Closes questions nobody needs any more: untouched for 14 days and asked
 * fewer than 3 times. The asker already got the assistant's reply when they
 * asked; what is left behind is mostly fragments ("Statu", "Okay", a phone
 * number) that no admin can usefully answer. Marked "ignored", never deleted,
 * so an admin can still answer one later. A question asked 3+ times stays
 * open whatever its age — repetition means it is real.
 */
export async function closeStaleQuestions(db: SupabaseClient, opts: { staleDays?: number } = {}): Promise<number> {
  const cutoff = new Date(Date.now() - (opts.staleDays ?? 14) * 86_400_000).toISOString();
  const { data, error } = await db
    .from("unknown_questions")
    .update({ status: "ignored" })
    .eq("status", "pending")
    .lt("last_seen_at", cutoff)
    .lt("occurrence_count", 3)
    .select("id");
  if (error) {
    console.error("[self-heal] closeStaleQuestions failed:", error.message);
    return 0;
  }
  return data?.length ?? 0;
}
