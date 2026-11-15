import type { SupabaseClient } from "@supabase/supabase-js";
import { isPaymentNudgeEnabled } from "@/lib/services/payment-settings";
import { notifyStudent } from "@/lib/services/student-notifications";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";
import { displayIdFor } from "@/lib/whatsapp/open-questions";

/**
 * Proactive nudges — a daily sweep piggy-backed onto the existing /api/ping
 * cron (same reasoning as item #102's auth-table cleanup: this Hobby-plan
 * project can't afford a second Vercel cron, so maintenance work rides the
 * one that already exists rather than adding another).
 *
 * Two independent nudges. Each is wrapped in its own try/catch and neither
 * throws, so one failing never blocks the other or the keep-alive ping
 * itself.
 */

/** Once every 3 days per student — a reminder, not a daily nag. */
const PAYMENT_REMINDER_COOLDOWN_HOURS = 72;
/** Never nag someone who registered moments ago. */
const REGISTRATION_GRACE_HOURS = 24;
/** Safety ceiling on one sweep — this runs from a cron, unattended. */
const MAX_PAYMENT_REMINDERS_PER_RUN = 200;

/** Escalate a question to admins once it's sat unanswered this long. */
const QUESTION_STALE_HOURS = 24;
/** Don't re-escalate the same still-open question more than once/day. */
const QUESTION_REMINDER_COOLDOWN_HOURS = 24;
/** How many stale questions to name in one WhatsApp message. */
const MAX_QUESTIONS_PER_ESCALATION = 10;

/**
 * A standalone "you still haven't paid" reminder to registered, unpaid
 * students — regardless of whether a classmate has recently paid. That case
 * (social-proof nudge on someone ELSE'S approval) is already covered by
 * `nudgeUnpaidStudentsAfterPayment` (services/payment-announcements.ts,
 * item #108); this is the standalone version that fires on its own schedule
 * so a student isn't only reminded when a classmate happens to pay.
 *
 * Reuses the SAME kill switch (`payment_nudge_enabled`) as that feature —
 * same category of "push to a student's phone about their unpaid fee," not
 * a new toggle to add to Settings. Reuses the SAME cooldown ledger table
 * (`student_notifications`) but a DISTINCT `type` ("payment_reminder", not
 * "payment_nudge") so the two features' cooldowns never interfere with each
 * other's counts.
 *
 * The fee amount IS named in the message — `batches.fee_amount` only gets
 * set once an admin has actually finalised and announced it (batch
 * lifecycle rule, Section 1), so this is not the "pre-announcing an
 * unfinalised fee" rule 8 exists to stop; item #113's own FOMO broadcast
 * named the same finalised amount with no objection.
 */
export async function sendStandalonePaymentReminders(
  db: SupabaseClient,
): Promise<{ sent: number; skippedRecent: number; eligible: number }> {
  const result = { sent: 0, skippedRecent: 0, eligible: 0 };
  try {
    if (!(await isPaymentNudgeEnabled(db))) return result;

    const graceCutoff = new Date(Date.now() - REGISTRATION_GRACE_HOURS * 3600_000).toISOString();

    // Only batches whose fee is actually set — nothing to remind about
    // otherwise (a pending_setup/unset-fee batch always has fee_amount null).
    const { data: batches } = await db
      .from("batches")
      .select("id, name, fee_amount")
      .not("fee_amount", "is", null)
      .neq("status", "archived");
    const feeByBatch = new Map((batches ?? []).map((b: any) => [b.id, b]));
    const batchIds = [...feeByBatch.keys()];
    if (!batchIds.length) return result;

    // Registered (enrolment rule — item #103: batch_id + is_profile_complete,
    // role-independent) students in those batches, past the grace period.
    const { data: candidates } = await db
      .from("profiles")
      .select("id, full_name, batch_id, created_at")
      .in("batch_id", batchIds)
      .eq("is_profile_complete", true)
      .lte("created_at", graceCutoff);

    const ids = (candidates ?? []).map((r: any) => r.id as string);
    if (!ids.length) return result;

    const { data: approvedRows } = await db
      .from("payments")
      .select("student_id")
      .in("student_id", ids)
      .eq("status", "approved");
    const paidSet = new Set((approvedRows ?? []).map((r: any) => r.student_id as string));

    const unpaid = (candidates ?? []).filter((c: any) => !paidSet.has(c.id));
    result.eligible = unpaid.length;
    if (!unpaid.length) return result;

    const since = new Date(Date.now() - PAYMENT_REMINDER_COOLDOWN_HOURS * 3600_000).toISOString();
    const { data: recent } = await db
      .from("student_notifications")
      .select("student_id")
      .eq("type", "payment_reminder")
      .gte("sent_at", since);
    const recentlyReminded = new Set((recent ?? []).map((r: any) => r.student_id as string));

    for (const student of unpaid) {
      if (result.sent >= MAX_PAYMENT_REMINDERS_PER_RUN) break;
      if (recentlyReminded.has(student.id)) { result.skippedRecent++; continue; }
      const batch = feeByBatch.get(student.batch_id);
      if (!batch) continue;
      const fee = Number(batch.fee_amount); // rule 4: fee_amount is NUMERIC -> arrives as a string
      const firstName = (student.full_name ?? "").trim().split(/\s+/)[0];
      const message =
        `👋 Hi${firstName ? ` ${firstName}` : ""}, this is a reminder to complete your ₹${fee.toLocaleString("en-IN")} payment for ${batch.name}. ` +
        `Open your Student App to pay and secure your seat.`;
      try {
        // allowTemplateFallback: this reminder exists specifically to reach
        // students who AREN'T currently talking to the bot — the one class
        // of notification where failing silently outside Meta's 24h window
        // would defeat the entire point of the feature. See item #181.
        await notifyStudent(db, student.id, "payment_reminder", message, undefined, { allowTemplateFallback: true });
        result.sent++;
      } catch (e) {
        console.error("[proactive-nudges] payment reminder failed for", student.id, e);
      }
    }

    console.info(
      `[proactive-nudges] payment reminders eligible=${result.eligible} sent=${result.sent} skippedRecent=${result.skippedRecent}`,
    );
    return result;
  } catch (e) {
    console.error("[proactive-nudges] payment reminder sweep failed:", e);
    return result;
  }
}

/**
 * Re-alerts admins about student questions that have sat pending too long.
 *
 * The existing alert (`notifyAdminWhatsApp`, whatsapp/admin.ts) fires once,
 * the moment a question is first recorded — there was never a follow-up if
 * nobody actually answered it, so a question could sit open indefinitely
 * with no second reminder. This is that second reminder, gated by its own
 * `admin_reminded_at` column (distinct from `last_seen_at`, which tracks
 * when the SAME question was last re-asked, not when admins were last
 * reminded about it) so the same still-open question isn't re-escalated
 * more than once per cooldown window.
 */
export async function escalateUnansweredQuestions(
  db: SupabaseClient,
): Promise<{ escalated: number }> {
  try {
    const staleCutoff = new Date(Date.now() - QUESTION_STALE_HOURS * 3600_000).toISOString();
    const reminderCutoff = new Date(Date.now() - QUESTION_REMINDER_COOLDOWN_HOURS * 3600_000).toISOString();

    const { data: stale } = await db
      .from("unknown_questions")
      .select("id, short_id, question, occurrence_count, first_seen_at, admin_reminded_at")
      .eq("status", "pending")
      .lte("first_seen_at", staleCutoff)
      .or(`admin_reminded_at.is.null,admin_reminded_at.lte.${reminderCutoff}`)
      .order("occurrence_count", { ascending: false })
      .limit(MAX_QUESTIONS_PER_ESCALATION);

    const rows = (stale ?? []) as Array<{
      id: string; short_id: number | null; question: string; occurrence_count: number;
    }>;
    if (!rows.length) return { escalated: 0 };

    const phones = await getActiveAdminPhones(db);
    if (!phones.length) return { escalated: 0 };

    const lines = rows.map((r) =>
      `*${displayIdFor(r.short_id, r.id)}* — ${r.question}${r.occurrence_count > 1 ? ` (asked ${r.occurrence_count}×)` : ""}`,
    );
    const text =
      `⏰ *${rows.length} question${rows.length === 1 ? "" : "s"} still unanswered after 24h+*\n\n` +
      lines.join("\n\n") +
      `\n\n━━━━━━━━━━━━━━\nSend *QUESTIONS* to see the full open list, or *ANSWER <id>* to answer one directly.`;

    await Promise.all(phones.map((p) => sendWhatsAppText(normalizeWhatsAppNumber(p), text).catch(() => {})));

    await db.from("unknown_questions")
      .update({ admin_reminded_at: new Date().toISOString() })
      .in("id", rows.map((r) => r.id));

    return { escalated: rows.length };
  } catch (e) {
    console.error("[proactive-nudges] question escalation sweep failed:", e);
    return { escalated: 0 };
  }
}
