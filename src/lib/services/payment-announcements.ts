import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isGroupChatEnabled,
  isPaymentAnnouncementsEnabled,
  isPaymentNudgeEnabled,
} from "@/lib/services/payment-settings";
import { notifyStudent } from "@/lib/services/student-notifications";

/**
 * One nudge per student per day, however many classmates pay that day.
 *
 * Without this, a batch with 38 unpaid students sends 38 messages on EVERY
 * approval, and each of those students is pinged again for every subsequent
 * payer — dozens of notifications a day telling them the same thing. That is
 * not a nudge, it is a reason to block the number, and this platform's login
 * OTP rides on that same WhatsApp number: losing its quality rating would
 * lock every student out, not just annoy them.
 */
const NUDGE_COOLDOWN_HOURS = 24;

/**
 * Ceiling on sends per approval. The Cashfree webhook is on the critical path
 * for confirming someone's payment, so it must return quickly — it cannot sit
 * through an unbounded loop of network sends. In practice the cooldown keeps
 * the real number far below this; the cap only guards the first payment of a
 * day in a large batch.
 */
const MAX_NUDGES_PER_APPROVAL = 25;

/**
 * Posts "<name> just paid — N of M have now paid" into a batch's Discussion
 * when a payment is approved.
 *
 * The point is social proof on a fee drive: a student deciding whether to pay
 * sees that their own classmates already have, and how close the batch is to
 * everyone being in. Requested directly — "in every successful payment send a
 * message in app chat where a members can see how many have paid... it helps
 * in others to pay".
 *
 * ── Where this is called from, and why only there ──────────────────────────
 * `autoApprovePayment` is the single funnel every approval path goes through
 * (Cashfree webhook, the manual-UPI admin approve, the status-page
 * reconciliation, and the Copilot's approve_payment). It is called AFTER that
 * function's `count === 0` guard, which only lets one caller win the
 * submitted→approved transition — so a webhook retry, or a reconcile racing
 * the webhook, cannot produce a second announcement for the same payment.
 * Do not call this from anywhere else: any other call site would lose that
 * guarantee and start double-posting.
 *
 * ── Counting ──────────────────────────────────────────────────────────────
 * Deliberately matches the numbers the admin dashboard shows for the same
 * batch (verified against GNITC Batch 1: 7 of 45, identical to batch-summary,
 * batch stats and the roster). Enrolment is `batch_id + is_profile_complete`,
 * role-independent — see services/enrollment.ts; a bare `batch_id` means
 * someone opened the link and abandoned the form (item #55) and must not
 * inflate the denominator. Both queries are scoped to the one batch, so
 * neither needs the id-chunking that unscoped queries do (item #102).
 *
 * Best-effort by contract: never throws, never blocks an approval. A student's
 * payment must never fail because a chat notice could not be posted.
 */
export async function announcePaymentInBatchChat(
  db: SupabaseClient,
  opts: { studentId: string; batchId: string },
): Promise<void> {
  try {
    // No point posting into a chat nobody can open, and the announcement has
    // its own kill switch because it names individuals publicly.
    const [chatOn, announceOn] = await Promise.all([
      isGroupChatEnabled(db),
      isPaymentAnnouncementsEnabled(db),
    ]);
    if (!chatOn || !announceOn) return;

    const { data: student } = await db
      .from("profiles")
      .select("full_name")
      .eq("id", opts.studentId)
      .maybeSingle();
    const name = (student?.full_name ?? "").trim();
    if (!name) return; // never post an anonymous "someone just paid"

    const [{ count: enrolled }, { data: approvedRows }] = await Promise.all([
      db.from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("batch_id", opts.batchId)
        .eq("is_profile_complete", true),
      db.from("payments")
        .select("student_id")
        .eq("batch_id", opts.batchId)
        .eq("status", "approved"),
    ]);

    // Distinct payers: a student can hold more than one payment row (item #100
    // — a duplicate order created moments after a successful one), and that
    // must not count as two people having paid.
    const paid = new Set((approvedRows ?? []).map((r: { student_id: string }) => r.student_id)).size;
    const total = enrolled ?? 0;
    if (paid === 0) return;

    const tally = total > 0
      ? `${paid} of ${total} students have now paid`
      : `${paid} ${paid === 1 ? "student has" : "students have"} now paid`;

    const { error } = await db.from("group_messages").insert({
      batch_id: opts.batchId,
      // The payer's own profile satisfies the NOT NULL sender FK, and means the
      // notice cascades away with them if they are ever deleted — their name
      // should not outlive their record. sender_role "system" is what makes the
      // UI render it as a centred notice instead of a chat bubble from them.
      sender_id: opts.studentId,
      sender_name: name,
      sender_role: "system",
      body: `✅ ${name} just paid · ${tally}`,
    });
    if (error) console.error("[payment-announcements] insert failed:", error.message);
  } catch (e) {
    console.error("[payment-announcements] failed:", e);
  }
}

/**
 * Nudges the batch's UNPAID students that a classmate just paid, and that
 * only a few seats are left in the batch. Requested alongside the in-chat
 * whatsapp message to unpaid students in that batch".
 *
 * Delivery goes through `notifyStudent`, which tries Web Push first and falls
 * back to WhatsApp — the best reach available, and it writes the
 * `student_notifications` row this function's own cooldown then reads.
 *
 * ── Two honest limits, neither of which is a bug in this code ──────────────
 * 1. WhatsApp free-form messages only deliver inside 24h of the student's own
 *    last message to the bot (Meta's rule). Outside it, delivery is not
 *    possible on WhatsApp — broadcasts are free-only, no paid template is in
 *    use. Measured on GNITC Batch 1 at build time: of 38 unpaid students,
 *    3 had Web Push and 3 were inside the WhatsApp window. So this reaches a
 *    handful today and grows as students install the app — it is not a way
 *    to reach all 38 right now.
 * 2. It never nudges the same student twice within NUDGE_COOLDOWN_HOURS, and
 *    never sends more than MAX_NUDGES_PER_APPROVAL per payment.
 *
 * Best-effort by contract: never throws, never blocks an approval.
 */
export async function nudgeUnpaidStudentsAfterPayment(
  db: SupabaseClient,
  opts: { batchId: string; payerName: string; excludeStudentId: string },
): Promise<{ sent: number; skippedRecent: number; eligible: number }> {
  const result = { sent: 0, skippedRecent: 0, eligible: 0 };
  try {
    if (!(await isPaymentNudgeEnabled(db))) return result;

    // Enrolled students in this batch (role-independent — services/enrollment.ts)
    const { data: enrolled } = await db
      .from("profiles")
      .select("id")
      .eq("batch_id", opts.batchId)
      .eq("is_profile_complete", true);
    // Count the whole enrolled cohort, then drop the payer only from the SEND
    // list — deriving the total as "recipients + 1" would be wrong whenever
    // the payer is not themselves an enrolled row.
    const allIds = (enrolled ?? []).map((r: { id: string }) => r.id);
    const ids = allIds.filter((id) => id !== opts.excludeStudentId);
    if (ids.length === 0) return result;

    const { data: approvedRows } = await db
      .from("payments")
      .select("student_id")
      .eq("batch_id", opts.batchId)
      .eq("status", "approved");
    const paidSet = new Set((approvedRows ?? []).map((r: { student_id: string }) => r.student_id));

    const unpaid = ids.filter((id) => !paidSet.has(id));
    result.eligible = unpaid.length;
    if (unpaid.length === 0) return result;

    // Who has already been nudged inside the cooldown window.
    const since = new Date(Date.now() - NUDGE_COOLDOWN_HOURS * 3600_000).toISOString();
    const { data: recent } = await db
      .from("student_notifications")
      .select("student_id")
      .eq("type", "payment_nudge")
      .gte("sent_at", since);
    const recentlyNudged = new Set((recent ?? []).map((r: { student_id: string }) => r.student_id));

    const message =
      `💪 <b>${opts.payerName} just paid.</b>\n\n` +
      `Only a few seats are left in your batch. ` +
      `Open your Student App to complete your payment and secure yours — the petition can only move forward once everyone is in.`;

    for (const studentId of unpaid) {
      if (result.sent >= MAX_NUDGES_PER_APPROVAL) break;
      if (recentlyNudged.has(studentId)) { result.skippedRecent++; continue; }
      try {
        // Same reasoning as the standalone reminder (item #181): this exists
        // to reach students NOT currently talking to the bot. NOTE: the
        // allowTemplateFallback flag below is a legacy no-op — notifyStudent
        // never sends a paid template, so outside Meta's 24h window the
        // nudge only reaches students with Web Push. The existing per-student
        // 24h cooldown and MAX_NUDGES_PER_APPROVAL cap already bound the
        // send volume.
        await notifyStudent(db, studentId, "payment_nudge", message, undefined, { allowTemplateFallback: true });
        result.sent++;
      } catch (e) {
        console.error("[payment-announcements] nudge failed for", studentId, e);
      }
    }

    console.info(
      `[payment-announcements] nudge batch=${opts.batchId} eligible=${result.eligible} ` +
      `sent=${result.sent} skippedRecent=${result.skippedRecent}`,
    );
    return result;
  } catch (e) {
    console.error("[payment-announcements] nudge sweep failed:", e);
    return result;
  }
}

