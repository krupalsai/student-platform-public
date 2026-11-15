import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { findStudentByPhone, normalizePhone } from "@/lib/services/students";
import { getPaymentStatus } from "@/lib/services/payments";
import { resolveStudentByNamePrefix } from "@/lib/whatsapp/recipient-lookup";
import {
  parseStudentLookupQuery,
  formatLookupAnswer,
  CHECK_USAGE,
  FOLLOWUP_NO_CONTEXT,
  type LookupResult,
  type LookupProfile,
} from "./student-lookup-text";

/**
 * Admin-only "did this student register?" lookup for the WhatsApp bot.
 * Pure parsing/formatting lives in student-lookup-text.ts (unit-tested);
 * this file is the DB + send half.
 *
 * Live failure, 2026-10-26: the owner shared a student's number
 * (9876543201, Sample Student) and asked "Did she register?" twice.
 * Both times the bot answered with the generic Platform Status totals
 * (Students: 102, Pending: 0, Approved: 59) — true numbers, but not an
 * answer about her. Two gaps caused it:
 *
 *   1. A bare phone number is not an admin command, so handleAdminCommand
 *      returned false and the message fell through to the STATUS_REQUEST
 *      classifier, which answered with all-time totals.
 *   2. "Did she register?" names nobody, so nothing could look anyone up
 *      — the bot had no memory of the number sent one message earlier.
 *
 * This closes both: a bare 10-digit number (or CHECK <phone|name>) looks
 * the student up immediately, and the looked-up number is remembered for
 * 30 minutes so a pronoun follow-up ("did she register?", "did they
 * pay?") answers about the same student. The memory reuses the
 * whatsapp_moderation.last_intent column every other follow-up already
 * uses (PAID_COUNT, ADMIN_REG_STATS, COLLEGE_SEARCH) — no schema change.
 *
 * 2026-10-26, second failure: the lookup memory is clobbered by any other
 * admin question — last_intent is one shared slot, so "How many
 * registrations today" (ADMIN_REG_STATS) wipes the STUDENT_LOOKUP marker
 * and the next "Did she pay?" degrades to "send the number first". The
 * marker is therefore ALSO kept under a namespaced `student_lookup` key
 * inside whatsapp_moderation.admin_batch_draft (JSONB, read-modify-write
 * so an in-progress batch draft is never wiped; the batch flow only reads
 * its own keys, so the extra key is ignored there). getLastLookupPhone
 * reads the last_intent marker first and falls back to the draft key.
 * A batch-draft write can still replace the whole draft object and drop
 * the backup — that only degrades to the old behaviour, never a wrong
 * answer about the wrong student.
 *
 * Reachability: only ever called from the router's ADMIN branch, after
 * getAdmin() recognised the sender and after handleAdminCommand() (so a
 * batch-draft number, an add-admin capture, MESSAGE, ANSWER and every
 * other typed command still win). A student number can never reach it.
 */

// ── Follow-up memory (whatsapp_moderation.last_intent + admin_batch_draft) ──

const LOOKUP_INTENT_PREFIX = "STUDENT_LOOKUP:";
const LOOKUP_FOLLOWUP_WINDOW_MS = 30 * 60 * 1000;
const LOOKUP_DRAFT_KEY = "student_lookup";

interface LookupDraftEntry {
  phone: string;
  at: string;
}

function lookupDraftEntryIsFresh(entry: unknown): entry is LookupDraftEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { phone?: unknown; at?: unknown };
  if (typeof e.phone !== "string" || !e.phone || typeof e.at !== "string") return false;
  const age = Date.now() - new Date(e.at).getTime();
  return age >= 0 && age <= LOOKUP_FOLLOWUP_WINDOW_MS;
}

async function getLastLookupPhone(
  db: SupabaseClient,
  adminPhone: string,
): Promise<string | null> {
  const { data } = await db
    .from("whatsapp_moderation")
    .select("last_intent, last_intent_at, admin_batch_draft")
    .eq("phone", normalizePhone(adminPhone))
    .maybeSingle();
  if (!data) return null;
  // Primary: the last_intent marker, as before.
  const intent = data.last_intent != null ? String(data.last_intent) : "";
  const intentAt = data.last_intent_at != null ? new Date(String(data.last_intent_at)).getTime() : NaN;
  if (intent.startsWith(LOOKUP_INTENT_PREFIX) && Number.isFinite(intentAt)) {
    const age = Date.now() - intentAt;
    if (age >= 0 && age <= LOOKUP_FOLLOWUP_WINDOW_MS) {
      return intent.slice(LOOKUP_INTENT_PREFIX.length) || null;
    }
  }
  // Backup: the namespaced draft key survives other admin questions
  // (stats, paid counts) that overwrite last_intent.
  const draft = (data as { admin_batch_draft?: unknown }).admin_batch_draft;
  const entry =
    draft && typeof draft === "object"
      ? (draft as Record<string, unknown>)[LOOKUP_DRAFT_KEY]
      : undefined;
  if (lookupDraftEntryIsFresh(entry)) return (entry as LookupDraftEntry).phone;
  return null;
}

async function setLastLookupPhone(
  db: SupabaseClient,
  adminPhone: string,
  phone: string,
): Promise<void> {
  // Non-critical: a missed follow-up marker must never fail the lookup.
  const normalisedAdmin = normalizePhone(adminPhone);
  const normalisedStudent = normalizePhone(phone);
  try {
    await db.from("whatsapp_moderation").upsert(
      {
        phone: normalisedAdmin,
        last_intent: `${LOOKUP_INTENT_PREFIX}${normalisedStudent}`,
        last_intent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "phone" },
    );
  } catch {
    /* ignore */
  }
  // Backup marker inside admin_batch_draft — read-modify-write, so an
  // in-progress batch draft (step/batchId/batchName) is preserved.
  try {
    const { data } = await db
      .from("whatsapp_moderation")
      .select("admin_batch_draft")
      .eq("phone", normalisedAdmin)
      .maybeSingle();
    const current =
      data?.admin_batch_draft && typeof data.admin_batch_draft === "object"
        ? (data.admin_batch_draft as Record<string, unknown>)
        : {};
    const entry: LookupDraftEntry = { phone: normalisedStudent, at: new Date().toISOString() };
    await db.from("whatsapp_moderation").upsert(
      {
        phone: normalisedAdmin,
        admin_batch_draft: { ...current, [LOOKUP_DRAFT_KEY]: entry },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "phone" },
    );
  } catch {
    /* ignore — the last_intent marker above is the primary memory */
  }
}

// ── Lookup ──────────────────────────────────────────────────────────────

export async function lookupStudentByPhone(
  db: SupabaseClient,
  phone: string,
): Promise<LookupResult> {
  const normalised = normalizePhone(phone);
  const profile = await findStudentByPhone(db, normalised);
  if (!profile) return { kind: "not-found-phone", phone: normalised };
  const payment = await getPaymentStatus(db, profile.id);
  const batch = (profile as unknown as { batches?: { name?: string | null; college?: string | null } | null }).batches ?? null;
  const mapped: LookupProfile = {
    full_name: profile.full_name ?? null,
    is_profile_complete: !!profile.is_profile_complete,
    created_at: (profile as { created_at?: string }).created_at ?? null,
    batches: batch ? { name: batch.name ?? null, college: batch.college ?? null } : null,
  };
  return {
    kind: "found",
    phone: normalised,
    profile: mapped,
    payment: { status: payment.status, amount: payment.amount, paidAt: payment.paidAt, gateway: payment.gateway ?? null },
  };
}

export async function lookupStudentByName(
  db: SupabaseClient,
  name: string,
): Promise<LookupResult> {
  const resolution = await resolveStudentByNamePrefix(db, name);
  if (resolution.kind === "none") return { kind: "not-found-name", name };
  if (resolution.kind === "ambiguous") {
    return { kind: "ambiguous", nameQuery: name, matches: resolution.matches };
  }
  return lookupStudentByPhone(db, resolution.match.phone);
}

/**
 * Admin-branch entry point. Returns true when the message was a lookup
 * (or a lookup-shaped question) so the caller stops here instead of
 * falling through to the STATUS classifier / FAQ / HELP.
 */
export async function answerStudentLookup(
  db: SupabaseClient,
  waFrom: string,
  text: string,
): Promise<boolean> {
  const parsed = parseStudentLookupQuery(text);
  if (parsed.kind === "none") return false;

  if (parsed.kind === "check-usage") {
    await sendWhatsAppText(waFrom, CHECK_USAGE);
    return true;
  }

  // A bare name only counts when it exactly matches a profile — otherwise
  // this was not a lookup at all (e.g. a stray phrase) and the caller
  // should keep falling through to HELP.
  if (parsed.kind === "bare-name") {
    const resolution = await resolveStudentByNamePrefix(db, parsed.name);
    if (resolution.kind === "none") return false;
    if (resolution.kind === "ambiguous") {
      await sendWhatsAppText(
        waFrom,
        formatLookupAnswer({
          kind: "ambiguous",
          nameQuery: parsed.name,
          matches: resolution.matches,
        }),
      );
      return true;
    }
    const result = await lookupStudentByPhone(db, resolution.match.phone);
    await sendWhatsAppText(waFrom, formatLookupAnswer(result));
    if (result.kind === "found" || result.kind === "not-found-phone") {
      await setLastLookupPhone(db, waFrom, result.phone);
    }
    return true;
  }

  const target = parsed.target;
  if (target.kind === "followup") {
    const phone = await getLastLookupPhone(db, waFrom);
    if (!phone) {
      await sendWhatsAppText(waFrom, FOLLOWUP_NO_CONTEXT);
      return true;
    }
    const result = await lookupStudentByPhone(db, phone);
    await sendWhatsAppText(waFrom, formatLookupAnswer(result));
    return true;
  }

  const result =
    target.kind === "phone"
      ? await lookupStudentByPhone(db, target.phone)
      : await lookupStudentByName(db, target.name);
  await sendWhatsAppText(waFrom, formatLookupAnswer(result));
  if (result.kind === "found" || result.kind === "not-found-phone") {
    await setLastLookupPhone(db, waFrom, result.phone);
  }
  return true;
}
