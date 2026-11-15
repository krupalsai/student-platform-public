/**
 * GET /api/phonepe/status/[merchantTxnId]
 *
 * Used by /pay/status/[merchantTxnId] (with ?gw=phonepe) to poll payment
 * status after the student returns from PhonePe's hosted checkout.
 *
 * This does NOT call PhonePe directly on every poll — it reads our own
 * `payments` table, which is kept up to date by the webhook
 * (/api/phonepe/webhook). This is safer and faster than hitting PhonePe's
 * status API on every poll, and the webhook is the single source of truth
 * for payment state.
 *
 * If the payment is still pg_pending after a few seconds (webhook delay),
 * this falls back to one active PhonePe status check, to avoid the student
 * being stuck if the webhook is slow or missed.
 */

import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, notFound, serverError } from "@/lib/api-response";
import { checkPhonePeStatus } from "@/lib/phonepe";
import { autoApprovePayment } from "@/lib/auto-approve";
import { canReadPayment } from "@/lib/authz";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ merchantTxnId: string }> }
) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  const { merchantTxnId } = await ctx.params;
  if (!merchantTxnId) return notFound("Transaction");

  try {
    const db = createServiceClient();

    const { data: payment } = await db.from("payments")
      .select("id, status, amount, utr_number, phonepe_txn_id, student_id, created_at")
      .eq("phonepe_merchant_txn_id", merchantTxnId)
      .maybeSingle();

    if (!payment) return notFound("Payment");

    // Ownership check, as an allow-list: only staff or the payment's own
    // owner may read it (item #102's "deny by default" lesson).
    if (!canReadPayment(user!.role, user!.profileId, payment.student_id)) {
      return forbidden();
    }

    // If still pg_pending and order is older than 5s, actively check PhonePe
    // (covers cases where the webhook hasn't arrived yet or was missed)
    const ageMs = Date.now() - new Date(payment.created_at).getTime();
    if (payment.status === "pg_pending" && ageMs > 5000) {
      const pgStatus = await checkPhonePeStatus(merchantTxnId);

      if (pgStatus.success && pgStatus.state === "COMPLETED") {
        // Security fix (2026-10-26): the amount PhonePe reports must match
        // the amount we recorded when the payment was created, before
        // anything is auto-approved — the webhook already does this check,
        // this poll did not. A mismatch is flagged for manual review instead
        // of approving. If PhonePe reports no amount at all, do NOT approve
        // here — leave the payment pending and let the webhook (the source
        // of truth, which does check the amount) handle it.
        const expectedPaise = Math.round(Number(payment.amount) * 100);
        if (typeof pgStatus.amount !== "number") {
          console.warn(`PhonePe status: no amount reported for ${merchantTxnId}; not auto-approving`);
          return ok({ status: payment.status, amount: payment.amount, merchant_txn_id: merchantTxnId });
        }
        if (pgStatus.amount !== expectedPaise) {
          console.error(
            `PhonePe status: amount mismatch for ${merchantTxnId} — expected ${expectedPaise}p, got ${pgStatus.amount}p`
          );
          await db.from("payments").update({
            status: "pg_failed",
            review_notes: `Amount mismatch: expected ₹${(expectedPaise / 100).toFixed(2)}, received ₹${(pgStatus.amount / 100).toFixed(2)}`,
          }).eq("id", payment.id).eq("status", "pg_pending");
          return ok({ status: "pg_failed", amount: payment.amount, merchant_txn_id: merchantTxnId });
        }

        // Guard the transition on status = pg_pending so a webhook that
        // approved this payment in the tiny window since we read it above is
        // never clobbered back to "submitted" by this poll. If the guard
        // no-ops (already moved on), autoApprovePayment below reads the fresh
        // status and returns already_approved.
        await db.from("payments").update({
          status: "submitted",
          utr_number: pgStatus.paymentInstrument?.utr || pgStatus.transactionId,
          phonepe_txn_id: pgStatus.transactionId,
          submitted_at: new Date().toISOString(),
        }).eq("id", payment.id).eq("status", "pg_pending");

        const result = await autoApprovePayment(db, payment.id);

        return ok({
          status: result.approved ? "approved" : "submitted",
          amount: payment.amount,
          merchant_txn_id: merchantTxnId,
        });
      }

      if (pgStatus.success && pgStatus.state === "FAILED") {
        await db.from("payments").update({ status: "pg_failed" }).eq("id", payment.id);
        return ok({ status: "pg_failed", amount: payment.amount, merchant_txn_id: merchantTxnId });
      }
      // still PENDING on PhonePe side — fall through to return current DB status
    }

    return ok({
      status: payment.status,
      amount: payment.amount,
      merchant_txn_id: merchantTxnId,
    });

  } catch (e: any) {
    console.error("PhonePe status check error:", e);
    return serverError();
  }
}
