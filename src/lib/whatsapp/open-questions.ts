import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/services/students";

/**
 * The open-question queue, as an admin sees it on WhatsApp.
 *
 * Tapping "Answer a Question" used to print a usage line with a made-up
 * example id ("ANSWER UQ-001") and nothing else — so an admin had no way to
 * find out what students had actually asked without opening the website. The
 * questions were being recorded correctly all along; they were simply never
 * shown. This module lists them.
 *
 * Kept out of admin-menu.ts so the ANSWER command in admin.ts can render the
 * same list after an answer is saved, without the two files importing each
 * other.
 */

export interface OpenQuestion {
  shortId: number | null;
  displayId: string;
  question: string;
  occurrences: number;
  phone: string | null;
  name: string | null;
  lastSeenAt: string | null;
}

/** UQ-045. Matches the id format the ANSWER command parses. */
export function displayIdFor(shortId: number | null, uuid: string): string {
  return shortId != null ? `UQ-${String(shortId).padStart(3, "0")}` : uuid.slice(0, 8);
}

/**
 * Pending questions, most-asked first, then most recent.
 *
 * Ordering matters: a question five students asked is worth answering before
 * one somebody typed at 2am, and answering it creates an FAQ that covers all
 * five at once.
 */
export async function fetchOpenQuestions(db: SupabaseClient, limit = 10): Promise<OpenQuestion[]> {
  const { data, error } = await db
    .from("unknown_questions")
    .select("id, short_id, question, occurrence_count, student_phone, last_seen_at")
    .eq("status", "pending")
    .order("occurrence_count", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[open-questions] fetch failed", error.message);
    return [];
  }

  const rows = data ?? [];

  // Resolve the askers' names in one query rather than one per row.
  const phones = Array.from(
    new Set(rows.map((r) => (r.student_phone ? normalizePhone(r.student_phone) : null)).filter(Boolean) as string[]),
  );
  const names = new Map<string, string>();
  if (phones.length) {
    const { data: mods } = await db
      .from("whatsapp_moderation")
      .select("phone, preferred_name")
      .in("phone", phones);
    for (const m of mods ?? []) {
      if (m.preferred_name) names.set(m.phone, m.preferred_name);
    }
  }

  return rows.map((r) => ({
    shortId: r.short_id ?? null,
    displayId: displayIdFor(r.short_id ?? null, r.id),
    question: r.question ?? "",
    occurrences: r.occurrence_count ?? 1,
    phone: r.student_phone ?? null,
    name: r.student_phone ? names.get(normalizePhone(r.student_phone)) ?? null : null,
    lastSeenAt: r.last_seen_at ?? null,
  }));
}

/** Total pending count — the list is capped, so the admin is told what's beyond it. */
export async function countOpenQuestions(db: SupabaseClient): Promise<number> {
  const { count } = await db
    .from("unknown_questions")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  return count ?? 0;
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
 * The WhatsApp message body listing the queue.
 *
 * Plain text, not an interactive list: a question can run to any length and
 * WhatsApp truncates list rows at 24/72 characters, which would hide the very
 * thing the admin needs to read before answering.
 */
export function formatOpenQuestions(questions: OpenQuestion[], total: number): string {
  if (!questions.length) {
    return (
      "✅ *No open questions*\n\n" +
      "Every question students have asked has been answered. " +
      "New ones arrive here automatically when the bot can't answer something itself."
    );
  }

  const lines = questions.map((q) => {
    const who = q.name ?? (q.phone ? `+${q.phone}` : "unknown");
    const when = agoLabel(q.lastSeenAt);
    const meta = [who, when, q.occurrences > 1 ? `asked ${q.occurrences}×` : ""].filter(Boolean).join(" · ");
    return `*${q.displayId}* — ${q.question}\n_${meta}_`;
  });

  const header = total > questions.length
    ? `❓ *Open questions* (${questions.length} of ${total})`
    : `❓ *Open questions* (${total})`;

  return (
    `${header}\n\n` +
    lines.join("\n\n") +
    `\n\n━━━━━━━━━━━━━━\nTo answer one, reply with the ID on the first line and your answer below it:\n\n` +
    `*ANSWER ${questions[0].displayId}*\n` +
    `your answer here\n\n` +
    `It is saved as an FAQ and sent to everyone who asked.`
  );
}

/** Convenience: fetch + count + format in one call. */
export async function buildOpenQuestionsMessage(db: SupabaseClient, limit = 10): Promise<string> {
  const [questions, total] = await Promise.all([fetchOpenQuestions(db, limit), countOpenQuestions(db)]);
  return formatOpenQuestions(questions, total);
}
