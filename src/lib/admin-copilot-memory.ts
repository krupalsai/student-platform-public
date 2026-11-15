import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Persistent conversation memory for the Admin Copilot (per admin).
 * Everything here is best-effort: if the table is unreachable the Copilot
 * still works, it just falls back to whatever history the browser sent.
 */
export type Turn = { role: "user" | "assistant"; content: string };

export const MEMORY_TURNS = 20;
const KEEP_DAYS = 30;
const MAX_STORED_CHARS = 3000;
const STORE_TIMEOUT_MS = 8000;

/** A store call that never resolves must not hang the chat — fail fast. */
async function withStoreTimeout<T>(label: string, p: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${STORE_TIMEOUT_MS}ms`)), STORE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadHistory(db: SupabaseClient, adminId: string, limit = MEMORY_TURNS): Promise<Turn[] | null> {
  try {
    const { data, error } = await withStoreTimeout("loadHistory", db
      .from("admin_copilot_messages")
      .select("role, content, created_at")
      .eq("admin_id", adminId)
      .order("created_at", { ascending: false })
      .limit(limit));
    if (error) { console.error("[copilot-memory] load failed", error.message); return null; }
    return (data ?? []).reverse().map(r => ({ role: r.role as Turn["role"], content: String(r.content ?? "") }));
  } catch (e) {
    console.error("[copilot-memory] load failed", (e as Error)?.message ?? e);
    return null;
  }
}

export async function saveTurns(db: SupabaseClient, adminId: string, turns: Turn[]): Promise<void> {
  const rows = turns
    .filter(t => t.content.trim())
    .map((t, i) => ({
      admin_id: adminId,
      role: t.role,
      content: t.content.slice(0, MAX_STORED_CHARS),
      // Keep user/assistant order stable inside one exchange.
      created_at: new Date(Date.now() + i).toISOString(),
    }));
  if (!rows.length) return;
  try {
    const { error } = await withStoreTimeout("saveTurns", db.from("admin_copilot_messages").insert(rows));
    if (error) { console.error("[copilot-memory] save failed", error.message); return; }
  } catch (e) {
    console.error("[copilot-memory] save failed", (e as Error)?.message ?? e);
    return;
  }
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
  try {
    await withStoreTimeout("saveTurns cleanup", db.from("admin_copilot_messages").delete().eq("admin_id", adminId).lt("created_at", cutoff));
  } catch (e) {
    console.error("[copilot-memory] cleanup failed", (e as Error)?.message ?? e);
  }
}

export async function clearHistory(db: SupabaseClient, adminId: string): Promise<void> {
  try {
    const { error } = await withStoreTimeout("clearHistory", db.from("admin_copilot_messages").delete().eq("admin_id", adminId));
    if (error) console.error("[copilot-memory] clear failed", error.message);
  } catch (e) {
    console.error("[copilot-memory] clear failed", (e as Error)?.message ?? e);
  }
}

/**
 * The single student the previous answer was about, if there was exactly one.
 * Student lookups render "• Name | Roll: XXXXXXXXXX | ...", so that line is
 * the anchor for "her / his / that student" in the next message.
 */
export function lastStudentFromHistory(history: Turn[]): { name: string; roll: string | null } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== "assistant") continue;
    const found = [...h.content.matchAll(/•\s*([^|\n•]{2,80}?)\s*\|\s*Roll:\s*([0-9a-z]{10}|not recorded)/gi)];
    if (found.length === 1) {
      const roll = /^not recorded$/i.test(found[0][2]) ? null : found[0][2];
      return { name: found[0][1].trim(), roll };
    }
    if (found.length > 1) return null; // ambiguous: several students listed
  }
  return null;
}

/**
 * Turns "show me her id card" into "show me her id card 23XXXXXXXX" when the
 * last answer was about exactly one student, so the deterministic lookups
 * (which do not use the model) can follow a pronoun like a chat assistant.
 */
export function resolveFollowUp(question: string, history: Turn[]): string {
  const refersBack = /\b(?:she|her|hers|he|him|his|that\s+student|this\s+student|the\s+same\s+(?:student|one))\b/i.test(question);
  if (!refersBack) return question;
  // Already names someone explicitly.
  if (/\b\d{2}[a-z0-9]{8}\b/i.test(question) || /[6-9]\d{4}[ -]?\d{5}/.test(question)) return question;
  const last = lastStudentFromHistory(history);
  if (!last) return question;
  return `${question} ${last.roll ?? last.name}`;
}

