import { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/embeddings";

export type FaqAudience = "public" | "student" | "admin";

export interface FaqAnswer {
  id: string;
  category: string | null;
  question: string;
  answer: string;
  audience?: FaqAudience;
}

/** Which FAQ audiences a sender may see. Unknown numbers get public only. */
export function audiencesFor(role: "unknown" | "student" | "admin"): FaqAudience[] {
  if (role === "admin") return ["public", "student", "admin"];
  if (role === "student") return ["public", "student"];
  return ["public"];
}

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().trim().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
}

const STOPWORDS = new Set([
  "is","the","a","an","what","how","when","where","why","who","which",
  "do","does","did","can","could","will","would","should","am","are","was","were",
  "i","my","me","to","for","of","in","on","at","by","and","or","if",
  "about","please","tell","have","has","this","that","it","you","your",
]);

function significantWords(text: string): string[] {
  return [...new Set(normalizeQuestion(text).split(" ").filter(w => w.length > 2 && !STOPWORDS.has(w)))];
}

/**
 * Prevent vague requests from becoming permanent knowledge. A question such
 * as "Give an estimation" has no useful subject, so an admin clarification
 * must leave it pending rather than creating a bad FAQ.
 */
export function isLikelyIncompleteQuestion(question: string): boolean {
  const q = normalizeQuestion(question);
  if (!q) return true;
  const words = q.split(" ");
  const meaningful = significantWords(question);
  if (meaningful.length <= 2 && /^(give|provide|tell|mention|send|share|show|need|want)\b/.test(q)) return true;
  if (/\b(give|provide|tell|mention|send|share|show)\b.*\b(estimation|estimate|details|information|info|clarification|something|anything)\b/.test(q) && meaningful.length <= 4) return true;
  return words.length <= 2 && meaningful.length === 0;
}

/** Clarification requests are instructions to the student, not FAQ answers. */
export function isClarificationAnswer(answer: string): boolean {
  const a = normalizeQuestion(answer);
  return /^(please|kindly)\b.*\b(clarif|clarify|mention|specify|provide|tell|explain|rephrase|complete)\b/.test(a)
    || /\b(please|kindly)\b.*\b(your question|more details|more information)\b/.test(a)
    || /\b(i|we)\s+(need|need more|require)\b.*\b(details|information|clarification)\b/.test(a);
}

const SEMANTIC_THRESHOLD = Number(process.env.FAQ_SEMANTIC_THRESHOLD ?? 0.75);

export async function searchFaq(db: SupabaseClient, question: string, opts: { trigramThreshold?: number } = {}): Promise<FaqAnswer | null> {
  const normalized = normalizeQuestion(question);
  if (!normalized) return null;

  const queryEmbedding = await embedText(question);
  if (queryEmbedding) {
    const { data: semantic, error } = await db.rpc("match_faqs", {
      query_embedding: queryEmbedding,
      match_threshold: SEMANTIC_THRESHOLD,
      match_count: 1,
    });
    if (!error && semantic?.length) {
      const top = semantic[0];
      return { id: top.id, category: top.category, question: top.question, answer: top.answer };
    }
  }

  const { data: trgmResults, error } = await db.rpc("search_faqs_trgm", {
    query_text: normalized,
    similarity_threshold: opts.trigramThreshold ?? 0.25,
    max_results: 1,
  });
  if (!error && trgmResults?.length) {
    const top = trgmResults[0];
    return { id: top.id, category: top.category, question: top.question, answer: top.answer };
  }

  const words = new Set(significantWords(question));
  if (words.size === 0) return null;
  const { data: faqs } = await db.from("faqs").select("id, category, question, answer, keywords").eq("enabled", true);
  let best: { faq: { id: string; category: string | null; question: string; answer: string }; score: number } | null = null;
  for (const faq of faqs ?? []) {
    const score = (faq.keywords ?? []).filter((k: string) => words.has(k.toLowerCase())).length;
    if (score > 0 && (!best || score > best.score)) best = { faq, score };
  }
  // A single shared keyword is not a confident match — a generic word like
  // "request" is a stored keyword on exactly one FAQ (Bonafide Certificate),
  // so a bare "Request" or "Request call" with zero other context matched
  // it every time, regardless of what was actually being asked (live-
  // reported: typing "Request" or "Request call" in Contact Support always
  // got the Bonafide Certificate steps back). Requiring at least 2 shared
  // keywords means a message needs real topical overlap with an FAQ, not
  // one incidental word, before this last-resort fallback fires; messages
  // that no longer clear this bar still reach the grounded LLM (which gets
  // every FAQ as context anyway) instead of a wrong canned answer.
  return best && best.score >= 2
    ? { id: best.faq.id, category: best.faq.category, question: best.faq.question, answer: best.faq.answer }
    : null;
}

export interface UnknownQuestionResult {
  id: string;
  occurrenceCount: number;
  isNew: boolean;
  saveFailed?: boolean;
}

export async function recordUnknownQuestion(
  db: SupabaseClient,
  question: string,
  opts: { phone?: string; college?: string } = {}
): Promise<UnknownQuestionResult> {
  const normalized = normalizeQuestion(question);
  const { data: existing } = await db.from("unknown_questions")
    .select("id, occurrence_count").eq("normalized_question", normalized).eq("status", "pending").maybeSingle();
  if (existing) {
    const occurrenceCount = existing.occurrence_count + 1;
    await db.from("unknown_questions").update({ occurrence_count: occurrenceCount, last_seen_at: new Date().toISOString() }).eq("id", existing.id);
    return { id: existing.id, occurrenceCount, isNew: false };
  }
  const { data: created, error } = await db.from("unknown_questions").insert({
    question, normalized_question: normalized, student_phone: opts.phone ?? null, college: opts.college ?? null,
  }).select("id").single();
  if (error || !created) {
    console.error("recordUnknownQuestion insert failed:", error);
    return { id: "", occurrenceCount: 1, isNew: true, saveFailed: true };
  }
  return { id: created.id, occurrenceCount: 1, isNew: true };
}

/**
 * Creates a live FAQ only when the student's question is specific enough and
 * the admin supplied a real answer. Clarification replies stay pending.
 */
export async function answerUnknownQuestion(
  db: SupabaseClient,
  unknownQuestionId: string,
  answer: string
): Promise<{ faqId: string } | null> {
  const { data: uq } = await db.from("unknown_questions").select("question").eq("id", unknownQuestionId).maybeSingle();
  if (!uq) return null;

  if (isLikelyIncompleteQuestion(uq.question) || isClarificationAnswer(answer)) {
    // Deliberately leave the question pending. Nothing is inserted into faqs.
    // The next student/admin interaction can clarify and answer it properly.
    return null;
  }

  const embedding = await embedText(uq.question);
  const { data: faq, error } = await db.from("faqs").insert({
    question: uq.question,
    answer: answer.trim(),
    keywords: significantWords(uq.question),
    ...(embedding ? { embedding } : {}),
  }).select("id").single();
  if (error || !faq) return null;
  await db.from("unknown_questions").update({ status: "answered", faq_id: faq.id }).eq("id", unknownQuestionId);
  return { faqId: faq.id };
}

/**
 * Returns the new draft's id when a genuinely new draft was created, or
 * null when it was skipped (incomplete question, a clarification answer,
 * a duplicate of an existing FAQ, or a DB error). Callers use the id to
 * proactively tell an admin a new draft is waiting — see notifyAdminOf
 * NewDraftFaq in whatsapp/draft-faqs.ts, item #206's "tell me before we
 * can grant that" follow-up. Before that, this returned void and an admin
 * only ever found out by manually running DRAFTS.
 */
export async function saveDraftFaq(db: SupabaseClient, question: string, answer: string): Promise<string | null> {
  try {
    const normalized = normalizeQuestion(question);
    if (!normalized || isLikelyIncompleteQuestion(question) || isClarificationAnswer(answer)) return null;
    const { data: existing } = await db.from("faqs").select("id").ilike("question", question.trim()).maybeSingle();
    if (existing) return null;
    const embedding = await embedText(question);
    const { data: inserted, error } = await db.from("faqs").insert({
      question: question.trim(), answer, keywords: significantWords(question), enabled: false, source: "ai_draft",
      ...(embedding ? { embedding } : {}),
    }).select("id").single();
    if (error || !inserted) return null;
    return inserted.id;
  } catch (e) {
    console.error("[faq] saveDraftFaq failed:", (e as Error).message);
    return null;
  }
}

export async function reindexFaqEmbeddings(db: SupabaseClient): Promise<{ total: number; embedded: number }> {
  const { data: faqs } = await db.from("faqs").select("id, question").is("embedding", null);
  const list = faqs ?? [];
  let embedded = 0;
  for (const f of list as Array<{ id: string; question: string }>) {
    const emb = await embedText(f.question);
    if (emb) {
      const { error } = await db.from("faqs").update({ embedding: emb }).eq("id", f.id);
      if (!error) embedded++;
    }
  }
  return { total: list.length, embedded };
}

export async function ignoreUnknownQuestion(db: SupabaseClient, unknownQuestionId: string): Promise<void> {
  await db.from("unknown_questions").update({ status: "ignored" }).eq("id", unknownQuestionId);
}

export async function listFaqs(db: SupabaseClient): Promise<FaqAnswer[]> {
  const { data } = await db.from("faqs").select("id, category, question, answer, audience").eq("enabled", true).order("category", { ascending: true });
  return data ?? [];
}

/** FAQs filtered to the audiences a sender is allowed to see. Fails closed. */
export async function listFaqsFor(db: SupabaseClient, audiences: FaqAudience[]): Promise<FaqAnswer[]> {
  const all = await listFaqs(db);
  const allowed = new Set<string>(audiences);
  return all.filter(f => allowed.has(f.audience ?? "public"));
}

