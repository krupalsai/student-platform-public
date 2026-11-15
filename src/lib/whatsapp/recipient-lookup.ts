import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolves a student by name for admin commands (MESSAGE, photo relay) that
 * used to require the admin to already know the phone number — reported live:
 * an admin typing "Message Asha Rao" got bounced to phone-number usage
 * help instead of the bot recognising a name it already has on file.
 */

export interface NameMatch {
  id: string;
  full_name: string;
  phone: string;
}

export type NameResolution =
  | { kind: "none" }
  | { kind: "one"; match: NameMatch; body: string }
  | { kind: "ambiguous"; matches: NameMatch[]; nameQuery: string };

/**
 * Greedy-longest-prefix match: tries the first N words of `text` (N from 5
 * down to 1) as a candidate full name against profiles.full_name, so a real
 * multi-word name ("Asha Devi Rao") isn't cut short by stopping at the
 * first word, while a single-word name still resolves. Whatever words are
 * left after the matched name become the message body.
 *
 * Case-insensitive exact match only (no fuzzy/partial) — a wrong photo/message
 * going to the wrong student on a typo is worse than asking the admin to spell
 * the name correctly or fall back to the phone number.
 */
export async function resolveStudentByNamePrefix(
  db: SupabaseClient,
  text: string,
): Promise<NameResolution> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: "none" };

  const { data, error } = await db
    .from("profiles")
    .select("id, full_name, phone")
    .not("full_name", "is", null)
    .not("phone", "is", null);
  if (error) {
    console.error("[recipient-lookup] profiles query failed:", error.message);
    return { kind: "none" };
  }
  const pool = (data ?? []) as { id: string; full_name: string | null; phone: string | null }[];
  if (!pool.length) return { kind: "none" };

  const maxWords = Math.min(words.length, 5);
  for (let n = maxWords; n >= 1; n--) {
    const candidate = words.slice(0, n).join(" ").trim().toLowerCase();
    const matches = pool.filter((p) => (p.full_name ?? "").trim().toLowerCase() === candidate);
    if (matches.length === 1) {
      const m = matches[0]!;
      return {
        kind: "one",
        match: { id: m.id, full_name: m.full_name!, phone: m.phone! },
        body: words.slice(n).join(" ").trim(),
      };
    }
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        nameQuery: candidate,
        matches: matches.map((m) => ({ id: m.id, full_name: m.full_name!, phone: m.phone! })),
      };
    }
  }
  return { kind: "none" };
}

/** "9876543210" -> "98765XXXXX" — enough for an admin to tell two students apart without exposing the full number in a list. */
export function maskPhone(phone: string): string {
  return phone.length >= 10 ? `${phone.slice(0, 5)}XXXXX` : phone;
}
