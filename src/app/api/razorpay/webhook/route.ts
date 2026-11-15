/**
 * POST /api/razorpay/webhook
 *
 * Set this as the webhook URL in the Razorpay dashboard (Settings →
 * Webhooks), subscribed to payment.captured. This is the safety net for
 * when the browser closes/crashes before POST /api/razorpay/verify runs —
 * mirrors the Cashfree webhook's security posture exactly:
 *   - HMAC signature verified before anything is read from the body
 *   - replay protection via webhook_events (provider + checksum)
 *   - amount-match validation before ever approving
 *   - unverified calls are rejected 401 and nothing is processed
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { verifyRazorpayWebhookSignature } from "@/lib/razorpay";
import { autoApprovePayment } from "@/lib/auto-approve";
import { audit } from "@/lib/audit";
import { settleExtraFeeOrder } from "@/lib/services/extra-fee";

export async function POST(req: NextRequest) {
  const rawBody   = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
    console.warn("[razorpay/webhook] invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const event   = String(body?.event ?? "");
  const entity  = body?.payload?.payment?.entity ?? {};
  const orderId = String(entity.order_id ?? "");
  const status  = String(entity.status ?? "");
  const amount  = Number(entity.amount ?? 0) / 100; // Razorpay sends paise
  const payId   = String(entity.id ?? "");
  const utr     = String(entity.acquirer_data?.bank_transaction_id ?? entity.acquirer_data?.rrn ?? "");

  if (!orderId) {
    return NextResponse.json({ ok: true, note: "no_order_id", event });
  }

  const db = createServiceClient();

  // ── Replay protection ────────────────────────────────────────────────────
  const checksum = signature ?? "";
  const { data: replay } = await db.from("webhook_events")
    .select("id").eq("provider", "razorpay").eq("checksum", checksum).maybeSingle();
  if (replay) {
    console.warn(`[razorpay/webhook] replay ignored for ${orderId}`);
    return NextResponse.json({ ok: true, note: "replay_ignored" });
  }
  const { error: logErr } = await db.from("webhook_events")
    .insert({ provider: "razorpay", merchant_txn_id: orderId, checksum });
  if (logErr?.code === "23505") {
    // Duplicate-key on (provider, checksum): the same signed event arrived
    // twice at once and both deliveries passed the replay check above
    // before either inserted (same race as the Cashfree webhook, confirmed
    // live there 5 Nov 2026). The first delivery owns this event;
    // acknowledge and stop instead of processing the payment twice.
    console.warn(`[razorpay/webhook] duplicate event ignored for ${orderId}`);
    return NextResponse.json({ ok: true, note: "already_processed" });
  }
  if (logErr) console.error("[razorpay/webhook] event log failed:", logErr.message);

  // ── Find our row ─────────────────────────────────────────────────────────
  const { data: paymentRow } = await db.from("payments")
    .select("id, status, student_id, amount")
    .eq("razorpay_order_id", orderId).maybeSingle();

  if (!paymentRow) {
    // Not a main-fee order — it may be the batch's separate second payment.
    const { data: extraRow } = await db.from("extra_fee_payments")
      .select("id, amount, status").eq("razorpay_order_id", orderId).maybeSingle();
    if (extraRow) {
      if (event === "payment.captured" && status === "captured") {
        const result = await settleExtraFeeOrder(db, extraRow, { paymentId: payId, amountPaise: Math.round(amount * 100), utr });
        return NextResponse.json({ ok: true, note: `extra_fee_${result}` });
      }
      if (event === "payment.failed" && extraRow.status === "pending") {
        await db.from("extra_fee_payments").update({ status: "failed", razorpay_payment_id: payId || null }).eq("id", extraRow.id).eq("status", "pending");
      }
      return NextResponse.json({ ok: true, note: "extra_fee_not_captured", event, status });
    }
    console.warn(`[razorpay/webhook] no payment found for order ${orderId}`);
    return NextResponse.json({ ok: true, note: "payment_not_found" });
  }
  if (paymentRow.status === "approved") {
    return NextResponse.json({ ok: true, note: "already_approved" });
  }

  await audit("payment.pg_webhook", "payment", paymentRow.id, {
    gateway: "razorpay", event, status, orderId, payId, amount,
  }, undefined, "system");

  // ── Not a capture event ──────────────────────────────────────────────────
  if (event !== "payment.captured" || status !== "captured") {
    if (event === "payment.failed") {
      await db.from("payments").update({
        status: "pg_failed",
        razorpay_payment_id: payId || null,
      }).eq("id", paymentRow.id);
    }
    return NextResponse.json({ ok: true, note: "not_captured", event, status });
  }

  // ── Amount-match validation ──────────────────────────────────────────────
  const expected = Math.round(Number(paymentRow.amount) * 100);
  const received = Math.round(amount * 100);
  if (expected > 0 && received !== expected) {
    console.error(`[razorpay/webhook] amount mismatch for ${orderId}: expected ${expected}p, got ${received}p`);
    await audit("payment.amount_mismatch", "payment", paymentRow.id, {
      gateway: "razorpay", orderId, expectedPaise: expected, receivedPaise: received,
    }, undefined, "system");
    await db.from("payments").update({
      status: "pg_failed",
      razorpay_payment_id: payId || null,
      review_notes: `Amount mismatch: expected ₹${(expected / 100).toFixed(2)}, received ₹${(received / 100).toFixed(2)}`,
    }).eq("id", paymentRow.id);
    return NextResponse.json({ ok: true, note: "amount_mismatch_flagged" });
  }

  // ── Success → submitted, then auto-approve ───────────────────────────────
  await db.from("payments").update({
    status: "submitted",
    utr_number: utr || payId || null,
    razorpay_payment_id: payId || null,
    submitted_at: new Date().toISOString(),
  }).eq("id", paymentRow.id);

  const result = await autoApprovePayment(db, paymentRow.id);

  return NextResponse.json({
    ok: true,
    order_id: orderId,
    payment_id: paymentRow.id,
    approved: result.approved,
    reason: result.reason,
  });
}
