/**
 * POST /api/razorpay/verify
 *
 * Called by the browser immediately after Razorpay Checkout's handler()
 * fires. This is the fast path for approval — the webhook (below) is the
 * safety net for when the browser closes/crashes before this call lands.
 *
 * Never trusts the browser's word alone: the signature proves Razorpay
 * generated this payment_id for this order_id, then we re-fetch the payment
 * from Razorpay's API and check it's actually captured before approving.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, conflict, serverError, zodError, notFound } from "@/lib/api-response";
import { verifyRazorpayPaymentSignature, fetchRazorpayPayment } from "@/lib/razorpay";
import { autoApprovePayment } from "@/lib/auto-approve";
import { audit } from "@/lib/audit";

const Schema = z.object({
  razorpay_order_id:   z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature:  z.string().min(1),
});

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body.data;

    if (!verifyRazorpayPaymentSignature({ orderId, paymentId, signature })) {
      console.warn("[razorpay/verify] invalid signature", orderId);
      return conflict("Payment signature could not be verified.");
    }

    const db = createServiceClient();
    const { data: payment } = await db.from("payments")
      .select("id, status, student_id, amount")
      .eq("razorpay_order_id", orderId).maybeSingle();

    if (!payment) return notFound("Payment");
    if (payment.student_id !== user!.profileId) return forbidden();
    if (payment.status === "approved") return ok({ status: "approved" });

    // Signature vouches for the sender, not for capture state or amount —
    // ask Razorpay directly, same posture as the Cashfree webhook.
    const live = await fetchRazorpayPayment(paymentId);
    if (!live.captured) {
      return conflict("Payment has not been captured yet. Please wait a moment and refresh.");
    }

    // `payments.amount` is stored in rupees, while Razorpay's Payment API
    // returns `amount` in paise. Compare both in paise; do not multiply the
    // Razorpay value again.
    const expectedPaise = Math.round(Number(payment.amount) * 100);
    const receivedPaise = Math.round(Number(live.amount));
    if (expectedPaise > 0 && receivedPaise !== expectedPaise) {
      console.error(`[razorpay/verify] amount mismatch for ${orderId}: expected ${expectedPaise}p, got ${receivedPaise}p`);
      await audit("payment.amount_mismatch", "payment", payment.id, {
        gateway: "razorpay", orderId, expectedPaise, receivedPaise,
      }, undefined, "system");
      await db.from("payments").update({
        status: "pg_failed",
        razorpay_payment_id: paymentId,
        review_notes: `Amount mismatch: expected ₹${(expectedPaise / 100).toFixed(2)}, received ₹${(receivedPaise / 100).toFixed(2)}`,
      }).eq("id", payment.id);
      return conflict("Payment amount did not match. This has been flagged for review.");
    }

    await db.from("payments").update({
      status: "submitted",
      razorpay_payment_id: paymentId,
      utr_number: live.acquirer_data?.bank_transaction_id || live.acquirer_data?.rrn || null,
      submitted_at: new Date().toISOString(),
    }).eq("id", payment.id);

    const result = await autoApprovePayment(db, payment.id);
    return ok({ status: result.approved ? "approved" : "submitted" });
  } catch (e) {
    console.error("[razorpay/verify]", e);
    return serverError();
  }
}
