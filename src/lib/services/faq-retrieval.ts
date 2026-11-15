/** Bounded FAQ retrieval. Candidates are evidence for the conversational model,
 * never an instruction to return the first FAQ verbatim. Keep user text out of logs. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "@/lib/embeddings";
import { listFaqsFor, type FaqAnswer, type FaqAudience } from "@/lib/services/faq";

import { rankFaqs } from "@/lib/services/faq-ranking";
import { retrieveFromKnowledgeBase, toFaqAnswer, normalizeKbText } from "@/lib/whatsapp/knowledge-base";

/**
 * Merges the curated static knowledge base (knowledge-base.ts) with database
 * FAQs. The static entries are verified and current, so when a static entry
 * and a database FAQ cover the same question, the static one wins — this is
 * how stale database answers (old fee wording, login links, Razorpay) are
 * shadowed without a database migration. Database FAQs still add anything
 * the static file does not cover.
 */
function mergeWithKnowledgeBase(
  dbFaqs: FaqAnswer[],
  question: string,
  audiences: FaqAudience[],
): FaqAnswer[] {
  const kbMatches = retrieveFromKnowledgeBase(question, audiences).map(toFaqAnswer);
  const seen = new Set(kbMatches.map((f) => normalizeKbText(f.question)));
  const extra = dbFaqs.filter((f) => !seen.has(normalizeKbText(f.question)));
  return [...kbMatches, ...extra];
}

export async function retrieveRelevantFaqs(
  db: SupabaseClient, question: string, history: { role: string; content: string }[] = [],
  audiences: FaqAudience[] = ["public"],
): Promise<{ faqs: FaqAnswer[]; method: "semantic" | "lexical" | "kb" | "none" }> {
  const context = [...history.filter(t => t.role === "user").slice(-2).map(t => t.content), question].join(" ").slice(0, 2000);
  const faqs = await listFaqsFor(db, audiences).catch(() => []);
  const kbOnly = retrieveFromKnowledgeBase(context, audiences).map(toFaqAnswer);
  if (!faqs.length) return { faqs: kbOnly, method: kbOnly.length ? "kb" : "none" };
  // Fetch multiple candidates rather than letting a low-score top-1 result own the response.
  const vector = await embedText(context);
  if (vector) {
    const { data, error } = await db.rpc("match_faqs", {
      query_embedding: vector, match_threshold: 0.70, match_count: 6,
    });
    if (!error && Array.isArray(data) && data.length) {
      const approved = new Map(faqs.map(f => [f.id, f]));
      const candidates = data.map((row: { id: string }) => approved.get(row.id)).filter((f: FaqAnswer | undefined): f is FaqAnswer => !!f);
      if (candidates.length) return { faqs: mergeWithKnowledgeBase(candidates, context, audiences), method: "semantic" };
    }
  }
  const candidates = rankFaqs(context, faqs);
  if (candidates.length) return { faqs: mergeWithKnowledgeBase(candidates, context, audiences), method: "lexical" };
  return { faqs: kbOnly, method: kbOnly.length ? "kb" : "none" };
}

