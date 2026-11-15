import type { SupabaseClient } from "@supabase/supabase-js";
import { PETITION_MIN_SEATS } from "@/lib/config";
import { findStudentByPhone, normalizePhone } from "@/lib/services/students";

/**
 * A name safe to use in a greeting: trimmed, single-line, first word only.
 * WhatsApp profile names are free text — they can be a nickname, an emoji
 * string, or a full name — so anything without a letter in it is not a name
 * we can greet with. Returns null in that case; callers fall back to the
 * generic greeting. Never returns a placeholder: no "Hi undefined", no
 * empty name.
 */
export function cleanDisplayName(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.replace(/[\r\n]+/g, " ").trim().split(/\s+/)[0] ?? "";
  if (!/\p{L}/u.test(first)) return null;
  if (first.length > 50) return null;
  return first;
}

/**
 * Resolve the name to greet this sender with, in priority order:
 *  1. the registered student profile's name (profiles.full_name by phone)
 *  2. a name this number already gave the bot (whatsapp_moderation.preferred_name)
 *  3. the sender's WhatsApp profile name (pushname from the webhook) — so
 *     an unregistered sender still gets a named greeting, not the generic one
 *  4. null — the caller falls back to the generic no-name greeting
 */
export async function resolveGreetingName(
  db: SupabaseClient,
  phone: string,
  profileName: string | null | undefined,
): Promise<string | null> {
  try {
    const student = await findStudentByPhone(db, phone);
    const fromProfile = cleanDisplayName(student?.full_name ?? null);
    if (fromProfile) return fromProfile;
  } catch { /* fall through to the next source */ }
  try {
    const { data } = await db
      .from("whatsapp_moderation")
      .select("preferred_name")
      .eq("phone", normalizePhone(phone))
      .maybeSingle();
    const fromKnown = cleanDisplayName(data?.preferred_name ?? null);
    if (fromKnown) return fromKnown;
  } catch { /* fall through to the next source */ }
  return cleanDisplayName(profileName);
}

/** Asked once, when we do not yet know who we are talking to. */
export function askNameMessage(name?: string | null): string {
  return processExplanationMessage(name ?? null);
}

export function processExplanationMessage(
  name: string | null,
  _minSeats = PETITION_MIN_SEATS,
): string {
  const display = cleanDisplayName(name);
  const hi = display ? `Hi ${display}!` : "Hi!";
  return (
    `${hi} Welcome to Student Support.\n\n`
    + `This platform was created for students who have completed graduation but are facing difficulties getting their original certificates from their college because government fee-reimbursement funds are pending.\n\n`
    + `When certificates are withheld over this issue, students can seek appropriate relief through a petition addressing the issue with the concerned authorities. Students who have faced similar certificate-withholding issues have also pursued legal remedies through petitions.\n\n`
    + `If you are facing this issue and want to be part of the petition, you can register below.\n\n`
    + `*This bot can:*\n`
    + `• Register you for the petition and send you the Student App link\n`
    + `• Answer common questions about the process and your registration\n`
    + `• Tell you how many students have registered/paid in your batch\n`
    + `• Connect you with an admin if something needs a human\n\n`
    + `Please choose an option below.`
  );
}

/**
 * The short greeting for a "Hi" that is not a first contact: the same
 * question the bot already asks, with the sender's name first when known.
 * The generic form is exactly the old reply, so nothing changes for a
 * sender with no name on record.
 */
export function shortGreetingMessage(name: string | null): string {
  const display = cleanDisplayName(name);
  const open = display ? `Hi ${display}, how` : "How";
  return `${open} can I help you today? Are you looking to register or have questions about your batch?`;
}

/**
 * Has this phone already had the full explanation?
 *
 * Kept on whatsapp_moderation (keyed by 10-digit phone), not on profiles:
 * most people who message the bot have no profile yet — the phone number is
 * the only identity available at "hi". A NEW contact never needs this check —
 * moderation.ts's own ask_name/name_collected sequence already fires exactly
 * once per phone. This function exists for the OTHER case: everyone who
 * already had a preferred_name recorded before this explanation existed, and
 * would otherwise never see it.
 */
export async function hasHadProcessExplanation(
  db: SupabaseClient,
  phone: string,
): Promise<boolean> {
  // Normalised here, not assumed of the caller — whatsapp_moderation.phone is
  // always the 10-digit form, and mixing it with the raw "91…" form is exactly
  // the bug bug #29 in this project's history had to clean up.
  const { data } = await db
    .from("whatsapp_moderation")
    .select("process_explained_at")
    .eq("phone", normalizePhone(phone))
    .maybeSingle();
  return !!data?.process_explained_at;
}

export async function markProcessExplained(db: SupabaseClient, phone: string): Promise<void> {
  // onConflict on the primary key so this updates the existing moderation row
  // in place, leaving preferred_name and the spam ladder untouched.
  await db.from("whatsapp_moderation").upsert(
    { phone: normalizePhone(phone), process_explained_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "phone" },
  );
}
