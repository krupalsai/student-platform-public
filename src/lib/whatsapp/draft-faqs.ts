import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";

/**
 * Self-learning FAQ drafts, as an admin sees them on WhatsApp.
 *
 * Every time the grounded LLM answers a question that had no FAQ match at
 * all (see saveDraftFaq in services/faq.ts), the Q&A is saved here as a
 * DRAFT (`faqs.enabled = false`) instead of going live automatically — an
 * unreviewed AI answer could be subtly wrong, and once it's a live FAQ it
 * gets served to every future student who asks something similar, with no
 * human in the loop at all. This module is how an admin reviews the queue
 * and either approves a draft (flips it live) or rejects it (deletes it),
 * mirroring the existing QUESTIONS / ANSWER pattern in open-questions.ts —
 * same list style, same "id on its own is enough" command shape.
 */

export interface DraftFaq {
  id: string;
  displayId: string;
  question: string;
  answer: string;
  createdAt: string | null;
}

/** First 8 chars of the UUID — faqs has no short_id column like unknown_questions does. */
export function displayIdFor(id: string): string {
  return id.slice(0, 8);
}

/** Oldest first — a FIFO queue, so nothing sits unreviewed indefinitely. */
export async function fetchDraftFaqs(db: SupabaseClient, limit = 10): Promise<DraftFaq[]> {
  const { data, error } = await db
    .from("faqs")
    .select("id, question, answer, created_at")
    .eq("enabled", false)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[draft-faqs] fetch failed", error.message);
    return [];
  }

  return (data ?? []).map((r) => ({
    id: r.id,
    displayId: displayIdFor(r.id),
    question: r.question ?? "",
    answer: r.answer ?? "",
    createdAt: r.created_at ?? null,
  }));
}

export async function countDraftFaqs(db: SupabaseClient): Promise<number> {
  const { count } = await db.from("faqs").select("id", { count: "exact", head: true }).eq("enabled", false);
  return count ?? 0;
}

/** Finds the one pending draft whose id starts with the given prefix (case-insensitive). Null if zero or more than one match. */
async function findDraftByPrefix(db: SupabaseClient, prefix: string): Promise<{ id: string; question: string } | null> {
  const { data } = await db.from("faqs").select("id, question").eq("enabled", false);
  const p = prefix.trim().toLowerCase();
  const matches = (data ?? []).filter((r) => r.id.toLowerCase().startsWith(p));
  return matches.length === 1 ? matches[0] : null;
}

/** Approves a draft — flips it live. Every read path (searchFaq, listFaqs, both match RPCs) starts matching it immediately. */
export async function approveDraftFaq(db: SupabaseClient, idPrefix: string): Promise<{ question: string } | null> {
  const draft = await findDraftByPrefix(db, idPrefix);
  if (!draft) return null;
  const { error } = await db.from("faqs").update({ enabled: true }).eq("id", draft.id);
  if (error) return null;
  return { question: draft.question };
}

/** Rejects a draft — deletes it outright rather than leaving a disabled row behind forever. */
export async function rejectDraftFaq(db: SupabaseClient, idPrefix: string): Promise<{ question: string } | null> {
  const draft = await findDraftByPrefix(db, idPrefix);
  if (!draft) return null;
  const { error } = await db.from("faqs").delete().eq("id", draft.id);
  if (error) return null;
  return { question: draft.question };
}

function agoLabel(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return "";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The WhatsApp message body listing the queue. Plain text, not an
 * interactive list — same reasoning as open-questions.ts: an AI-written
 * answer can run long, and WhatsApp truncates list rows.
 */
export function formatDraftFaqs(drafts: DraftFaq[], total: number): string {
  if (!drafts.length) {
    return (
      "✅ *No pending drafts*\n\n" +
      "Nothing waiting on review right now. New ones appear here automatically whenever the assistant answers a question that wasn't already in the FAQs."
    );
  }

  const lines = drafts.map((d) => {
    const when = agoLabel(d.createdAt);
    return `*${d.displayId}*\nQ: ${d.question}\nA: ${d.answer}${when ? `\n_${when}_` : ""}`;
  });

  const header = total > drafts.length
    ? `🧠 *Learned drafts, pending review* (${drafts.length} of ${total})`
    : `🧠 *Learned drafts, pending review* (${total})`;

  return (
    `${header}\n\n` +
    lines.join("\n\n") +
    `\n\n━━━━━━━━━━━━━━\n*APPROVE ${drafts[0].displayId}* — make it a live FAQ\n` +
    `*REJECT ${drafts[0].displayId}* — discard it`
  );
}

/** Convenience: fetch + count + format in one call. */
export async function buildDraftFaqsMessage(db: SupabaseClient, limit = 10): Promise<string> {
  const [drafts, total] = await Promise.all([fetchDraftFaqs(db, limit), countDraftFaqs(db)]);
  return formatDraftFaqs(drafts, total);
}

/**
 * Proactively tells every active admin a brand-new draft is waiting,
 * right when the bot answers a genuinely new question — not only when an
 * admin happens to run DRAFTS. The bot still answers the student
 * immediately either way; this is purely the admin-side "you'll be asked
 * before it becomes official" notice, same posture as notifyAdminWhatsApp's
 * escalation alert, just for a question the bot WAS able to answer rather
 * than one it couldn't. Best-effort — a failed send here must never block
 * the student's own reply, so every call site fires this after already
 * replying and swallows its own errors.
 */
export async function notifyAdminOfNewDraftFaq(
  db: SupabaseClient,
  id: string,
  question: string,
  answer: string,
): Promise<void> {
  try {
    const phones = await getActiveAdminPhones(db);
    if (!phones.length) return;
    const displayId = displayIdFor(id);
    const text =
      `🧠 *New learned answer*\n\n` +
      `The bot already replied to the student with this. In ~24h it is reviewed automatically against the platform facts and goes live for everyone if it passes — no action needed.\n\n` +
      `*Q:* ${question}\n` +
      `*A:* ${answer}\n\n` +
      `*APPROVE ${displayId}* — make it live now\n` +
      `*REJECT ${displayId}* — discard it before then`;
    await Promise.all(phones.map((p) => sendWhatsAppText(normalizeWhatsAppNumber(p), text)));
  } catch (e) {
    console.error("[draft-faqs] notifyAdminOfNewDraftFaq failed", (e as Error).message);
  }
}
