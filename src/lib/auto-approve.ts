import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { createPetitionForStudent } from "@/lib/services/petitions";
import { notifyStudent, paymentStatusMessage } from "@/lib/services/student-notifications";
import { sendSlackAlert } from "@/lib/services/slack";

export interface AutoApproveResult {
  approved: boolean;
  reason?: string;
  invite_sent?: boolean;
  invite_failed?: boolean;
  invite_pending?: boolean;
  batch_closed?: boolean;
}

export async function autoApprovePayment(
  db: SupabaseClient,
  paymentId: string,
  reviewedBy: string | null = null
): Promise<AutoApproveResult> {
  const { data: pay } = await db
    .from("payments")
    .select("id, status, student_id, invite_sent, batch_id, amount")
    .eq("id", paymentId)
    .maybeSingle();

  if (!pay) return { approved: false, reason: "payment_not_found" };
  if (pay.status === "approved") return { approved: false, reason: "already_approved" };

  const { data: profile } = await db.from("profiles")
    .select("batch_id, phone")
    .eq("id", pay.student_id)
    .maybeSingle();

  const effectiveBatchId = pay.batch_id ?? profile?.batch_id ?? null;

  if (effectiveBatchId && effectiveBatchId !== profile?.batch_id) {
    await db.from("profiles").update({ batch_id: effectiveBatchId }).eq("id", pay.student_id);
  }

  const paymentUpdate: Record<string, unknown> = {
    status: "approved",
    reviewed_by: reviewedBy,
    reviewed_at: new Date().toISOString(),
    review_notes: null,
  };
  if (effectiveBatchId && !pay.batch_id) paymentUpdate.batch_id = effectiveBatchId;

  // The .in(...) filter is the race guard (bug #18): only one caller can move a
  // payment out of submitted/reupload_requested, so a webhook retry or a
  // reconcile racing the webhook loses here instead of approving twice.
  //
  // Whether it won is decided by the RETURNED ROWS, not by `count`. PostgREST
  // only populates `count` when the request asks for it via a Prefer header —
  // i.e. `.select("id", { count: "exact" })`. A bare `.select("id")` always
  // came back with `count: null`, so `!count` was ALWAYS true and this
  // function returned "already_approved" on every single successful approval.
  // The row really was approved, but everything below this line — the
  // petition, the batch-chat announcement and unpaid nudge (item #108), the
  // payment.approved audit entry, and the student's own approval notification
  // — was unreachable and had never once run in production. `data.length` is
  // always populated for a select-on-update and needs no header.
  const { data: updated, error: err } = await db.from("payments")
    .update(paymentUpdate)
    .eq("id", paymentId)
    .in("status", ["submitted", "reupload_requested"])
    .select("id");

  if (err) { console.error("[lib/auto-approve] approve update failed:", err); return { approved: false, reason: "db_error" }; }
  if (!updated || updated.length === 0) return { approved: false, reason: "already_approved" };

  if (effectiveBatchId) {
    await createPetitionForStudent(db, pay.student_id, effectiveBatchId);

    // Social proof in the batch's own Discussion. Safe to sit here and only
    // here: the `count === 0` guard above means exactly one caller wins the
    // submitted→approved transition, so a webhook retry or a reconcile racing
    // the webhook cannot post twice. Best-effort — never blocks an approval.
    const { announcePaymentInBatchChat, nudgeUnpaidStudentsAfterPayment } =
      await import("@/lib/services/payment-announcements");
    await announcePaymentInBatchChat(db, { studentId: pay.student_id, batchId: effectiveBatchId });

    // ...and nudge the batch's unpaid students that a classmate just paid.
    // Rate-limited to one per student per day and capped per approval, so the
    // webhook stays fast and nobody gets a barrage — see the notes on
    // nudgeUnpaidStudentsAfterPayment.
    const { data: payer } = await db.from("profiles").select("full_name").eq("id", pay.student_id).maybeSingle();
    const payerName = (payer?.full_name ?? "").trim();
    if (payerName) {
      await nudgeUnpaidStudentsAfterPayment(db, {
        batchId: effectiveBatchId,
        payerName,
        excludeStudentId: pay.student_id,
      });
    }
  }

  await audit(
    "payment.approved",
    "payment",
    paymentId,
    { reviewed_by: reviewedBy, batch_id: effectiveBatchId, auto: reviewedBy === null },
    reviewedBy ?? undefined,
    reviewedBy ? "admin" : "system"
  );

  let batchName = "";
  let batchLimit: number | null = null;

  if (effectiveBatchId) {
    const { data: batch } = await db.from("batches")
      .select("name, batch_limit")
      .eq("id", effectiveBatchId)
      .maybeSingle();
    batchName = batch?.name ?? "";
    batchLimit = batch?.batch_limit ?? null;
  }

  // Student notifications are now WhatsApp-only. Telegram is no longer used
  // as a student interface, group-invite channel, or notification channel.
  // Always send the approval notification to the student's WhatsApp number,
  // including legacy students whose old `invite_sent` field was set by the
  // former Telegram flow. That legacy flag must never suppress a WhatsApp
  // notification.
  try {
    await notifyStudent(
      db,
      pay.student_id,
      "payment_approved",
      paymentStatusMessage("approved", batchName || undefined),
      paymentId,
      { channels: ["whatsapp"] },
    );

    // Registration is genuinely complete now — invalidate outstanding
    // registration tokens so stale/forwarded registration links cannot be reused.
    const { data: outstanding } = await db
      .from("registration_tokens")
      .select("id")
      .eq("profile_id", pay.student_id)
      .is("consumed_at", null);
    if (outstanding?.length) {
      const { consumeRegistrationToken } = await import("@/lib/registration-token");
      await Promise.all(outstanding.map((t: { id: string }) => consumeRegistrationToken(db, t.id)));
    }
  } catch (e) {
    console.error("[lib/auto-approve] student notification failed:", e);
  }

  // These legacy columns are retained for schema compatibility, but Telegram
  // invite delivery is no longer performed. They must not claim a Telegram
  // delivery happened.
  await db.from("payments").update({
    invite_sent: false,
    invite_sent_at: null,
    invite_failed: false,
    invite_pending: false,
  }).eq("id", paymentId);

  // A batch is NEVER auto-closed on reaching batch_limit. A college keeps
  // exactly one Active batch, and it stays open until the admin explicitly
  // ends it. batchLimit remains advisory only.
  void batchLimit;

  // Team alert in Slack — payment received. Best-effort, never blocks approval.
  try {
    const { data: payerRow } = await db.from("profiles").select("full_name, phone").eq("id", pay.student_id).maybeSingle();
    const amt = (pay as { amount?: number | string | null }).amount;
    const amtStr = amt != null && Number(amt) > 0 ? `\u20B9${Number(amt).toLocaleString("en-IN")}` : "";
    const who = (payerRow?.full_name ?? "").trim() || "A student";
    await sendSlackAlert(
      `\uD83D\uDCB0 *Payment received*${amtStr ? ` ${amtStr}` : ""}\n${who}${batchName ? ` \u2014 ${batchName}` : ""}${payerRow?.phone ? ` (${payerRow.phone})` : ""}`
    );
  } catch (e) {
    console.error("[lib/auto-approve] slack alert failed:", (e as Error).message);
  }

  return { approved: true, invite_sent: false, invite_failed: false, invite_pending: false, batch_closed: false };
}
