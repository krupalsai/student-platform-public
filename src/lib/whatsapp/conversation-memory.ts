import { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/services/students";

/**
 * Short-term conversation memory for the WhatsApp assistant.
 *
 * Persists a compact rolling transcript of the last few user/bot messages per
 * person in whatsapp_moderation.recent_turns (migration 0045), and reads it
 * back as chat turns for the LLM. This is what lets the assistant follow a
 * multi-turn conversation ("I already paid yesterday" → "yes, check status")
 * instead of treating every message as a cold start.
 *
 * Deliberately small: only the last MAX_TURNS are kept, and only turns inside
 * the current SESSION_WINDOW_MS are ever fed to the model, so prompt size,
 * cost, and cross-conversation bleed all stay bounded.
 *
 * Keyed by normalizePhone() (10-digit) — the SAME key moderation and the
 * intent-context helpers use, so everything about one person stays on one row
 * (see migration 0043 for why that matters).
 */

export type TurnRole = "user" | "bot";

/** Stored shape — kept compact on purpose (it's serialized on every turn). */
interface StoredTurn {
  r: "u" | "b";
  t: string;
  at: string;
}

/** Shape the LLM layer consumes. */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const MAX_TURNS = 10;
const SESSION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MAX_TEXT_LEN = 500; // never store an unbounded blob

/**
 * Appends one turn to the person's rolling transcript, capped to the last
 * MAX_TURNS. Read-modify-write on a single JSONB column; best-effort — a
 * memory write must never break the actual reply, so failures are logged and
 * swallowed. (Per-person concurrent writes are rare, and webhook dedup —
 * migration 0044 — removes the retry storms that would cause them.)
 */
export async function recordTurn(
  db: SupabaseClient,
  phone: string,
  role: TurnRole,
  text: string,
): Promise<void> {
  try {
    const p = normalizePhone(phone);
    const clean = (text ?? "").trim().slice(0, MAX_TEXT_LEN);
    if (!clean) return;

    const { data } = await db
      .from("whatsapp_moderation")
      .select("recent_turns")
      .eq("phone", p)
      .maybeSingle();

    const existing: StoredTurn[] = Array.isArray(data?.recent_turns) ? data!.recent_turns : [];
    const turn: StoredTurn = { r: role === "user" ? "u" : "b", t: clean, at: new Date().toISOString() };
    const next: StoredTurn[] = [...existing, turn].slice(-MAX_TURNS);

    // onConflict:"phone" so this only updates the transcript on the existing
    // row — never inserts a competing one, and never touches other columns.
    await db
      .from("whatsapp_moderation")
      .upsert({ phone: p, recent_turns: next, updated_at: new Date().toISOString() }, { onConflict: "phone" });
  } catch (e) {
    console.error("[conversation-memory] recordTurn failed:", (e as Error).message);
  }
}

/**
 * Returns the recent conversation as chat turns for the LLM, oldest first,
 * limited to the current session window. The just-received message is NOT
 * included here — callers pass it separately as the current question, and
 * should record it only AFTER building the history for this turn.
 */
export async function getRecentTurns(db: SupabaseClient, phone: string): Promise<ChatTurn[]> {
  try {
    const { data } = await db
      .from("whatsapp_moderation")
      .select("recent_turns")
      .eq("phone", normalizePhone(phone))
      .maybeSingle();

    const stored: StoredTurn[] = Array.isArray(data?.recent_turns) ? data!.recent_turns : [];
    const cutoff = Date.now() - SESSION_WINDOW_MS;

    return stored
      .filter(t => t?.t && t?.at && new Date(t.at).getTime() >= cutoff)
      .map(t => ({ role: t.r === "u" ? "user" : "assistant", content: t.t } as ChatTurn));
  } catch (e) {
    console.error("[conversation-memory] getRecentTurns failed:", (e as Error).message);
    return [];
  }
}
