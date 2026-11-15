/**
 * POST /api/phonepe/webhook
 *
 * PhonePe calls this URL after every payment (success, failure, pending).
 * Set this URL in your PhonePe merchant dashboard as the callback URL.
 *
 * On PAYMENT_SUCCESS:
 *   → marks payment as "submitted" with UTR from PhonePe
 *   → immediately auto-approves via autoApprovePayment()
 *   → sends the student their approval notification
 *
 * Security:
 *   - Verifies a per-request HMAC-SHA256 signature over the raw body
 *     (PHONEPE_WEBHOOK_SECRET, see verifyPhonePeWebhookSignature) —
 *     the old fixed SHA256(username:password) check was retired
 *     2026-10-26 because it was identical on every call and forgeable
 *     once seen. Fails closed when the secret is not configured.
 *   - Replay protection: every verified (signature, merchantTxnId) pair is
 *     logged once in `webhook_events`. If the exact same signed payload
 *     arrives again, it's recognized as a replay and not reprocessed —
 *     this is on top of the existing "already approved" idempotency guard.
 *   - Amount-match validation: the amount PhonePe reports in the webhook
 *     must match the amount we recorded when the payment was created.
 *     A mismatch (even with a valid signature) is rejected — this guards
 *     against a stolen/leaked valid signature being replayed with a
 *     tampered amount.
 *   - All unauthenticated/invalid calls are rejected 401/400.
 *
 * This webhook only ever does anything if PhonePe genuinely created the
 * order — it does not itself check `isPhonePeEnabled()`, matching the
 * Cashfree/Razorpay webhooks (a switch turned off after an order was
 * already placed must not orphan that order; the switch only controls
 * whether NEW orders can be created, at /api/phonepe/initiate).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { verifyPhonePeWebhookSignature } from "@/lib/phonepe";
import { autoApprovePayment } from "@/lib/auto-approve";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  // Per-request HMAC signature; falls back to the Authorization header,
  // which is where PhonePe delivers its webhook credential. The value is
  // never logged.
  const signature = req.headers.get("x-phonepe-signature") ?? req.headers.get("authorization") ?? "";

  // ── Verify signature (per-request HMAC over the raw body) ───────────────
  if (!verifyPhonePeWebhookSignature(rawBody, signature)) {
    console.warn("PhonePe webhook: invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ── Parse V2 webhook payload — plain JSON, no base64 envelope ───────────
  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = parsed.payload ?? {};
  const merchantTxnId: string = payload.originalMerchantOrderId ?? payload.merchantOrderId ?? "";
  const phonepeTxnId: string  = payload.orderId ?? payload.transactionId ?? "";
  // V2 event names look like "pg.order.completed" / "pg.order.failed" — map
  // to the same COMPLETED/FAILED/PENDING vocabulary the rest of this route
  // (and autoApprovePayment downstream) already expects, so nothing below
  // this block needs to change.
  const rawState: string      = payload.state ?? "";
  const state: string         = rawState === "COMPLETED" ? "COMPLETED"
                                : rawState === "FAILED"   ? "FAILED"
                                : "PENDING";
  const amountPaise: number   = payload.amount ?? 0;
  const firstPaymentDetail    = Array.isArray(payload.paymentDetails) ? payload.paymentDetails[0] : undefined;
  const utr: string           = firstPaymentDetail?.rail?.upiTransactionId ?? firstPaymentDetail?.transactionId ?? "";

  // Replay protection below keys off `checksum` in webhook_events — use
  // the per-request signature combined with merchantTxnId as the dedupe
  // key instead (the signature is never logged).
  const checksum = `${signature}:${merchantTxnId}:${payload.timestamp ?? ""}`;

  if (!merchantTxnId) {
    return NextResponse.json({ error: "Missing merchantTransactionId" }, { status: 400 });
  }

  // ── Sanity-check the payload shape before doing anything with it ─────────
  if (typeof amountPaise !== "number" || amountPaise < 0 || !Number.isFinite(amountPaise)) {
    console.warn(`PhonePe webhook: invalid amount in payload for ${merchantTxnId}`);
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(merchantTxnId)) {
    console.warn(`PhonePe webhook: malformed merchantTransactionId: ${merchantTxnId}`);
    return NextResponse.json({ error: "Invalid merchantTransactionId" }, { status: 400 });
  }

  const db = createServiceClient();

  // ── Replay protection ────────────────────────────────────────────────────
  // Every verified checksum is unique per PhonePe signed payload. If we've
  // already logged this exact checksum, this is a replay of a call we already
  // handled — acknowledge it but don't reprocess.
  const { data: replayCheck } = await db.from("webhook_events")
    .select("id")
    .eq("provider", "phonepe")
    .eq("checksum", checksum)
    .maybeSingle();

  if (replayCheck) {
    console.warn(`PhonePe webhook: replay detected for ${merchantTxnId}`);
    return NextResponse.json({ ok: true, note: "replay_ignored" });
  }

  // Log this verified webhook call before processing (best-effort; if this
  // insert fails we still proceed — the existing "already approved" check
  // in the payment row is the primary idempotency guard).
  await Promise.resolve(
    db.from("webhook_events").insert({
      provider: "phonepe",
      merchant_txn_id: merchantTxnId,
      checksum,
    })
  ).catch((e) => console.error("[api/phonepe/webhook] background task failed:", e));

  // ── Find the payment row ─────────────────────────────────────────────────
  const { data: payment } = await db.from("payments")
    .select("id, status, student_id, amount")
    .eq("phonepe_merchant_txn_id", merchantTxnId)
    .maybeSingle();

  if (!payment) {
    console.warn(`PhonePe webhook: no payment found for txn ${merchantTxnId}`);
    return NextResponse.json({ ok: true, note: "payment_not_found" });
  }

  // ── Already processed — idempotent ack ──────────────────────────────────
  if (payment.status === "approved") {
    return NextResponse.json({ ok: true, note: "already_approved" });
  }

  // ── Amount-match validation ──────────────────────────────────────────────
  // The amount PhonePe reports must match what we recorded when the payment
  // was created. This protects against a tampered amount even if a valid
  // signature were somehow reused — the signature alone isn't trusted to
  // also vouch for amount correctness on our side.
  const expectedPaise = Math.round(Number(payment.amount) * 100);
  if (state === "COMPLETED" && expectedPaise > 0 && amountPaise !== expectedPaise) {
    console.error(
      `PhonePe webhook: amount mismatch for ${merchantTxnId} — expected ${expectedPaise}p, got ${amountPaise}p`
    );
    await audit("payment.amount_mismatch", "payment", payment.id, {
      merchantTxnId, expectedPaise, receivedPaise: amountPaise,
    }, undefined, "system");
    // Flag for manual review instead of auto-approving a mismatched amount.
    await db.from("payments").update({
      status: "pg_failed",
      phonepe_txn_id: phonepeTxnId,
      review_notes: `Amount mismatch: expected ₹${(expectedPaise / 100).toFixed(2)}, received ₹${(amountPaise / 100).toFixed(2)}`,
    }).eq("id", payment.id);
    return NextResponse.json({ ok: true, note: "amount_mismatch_flagged" });
  }

  await audit("payment.pg_webhook", "payment", payment.id, {
    state, merchantTxnId, phonepeTxnId, amountPaise, utr,
  }, undefined, "system");

  if (state === "COMPLETED") {
    // ── Update to submitted with UTR ──────────────────────────────────────
    await db.from("payments").update({
      status:      "submitted",
      utr_number:  utr || phonepeTxnId,
      phonepe_txn_id: phonepeTxnId,
      submitted_at: new Date().toISOString(),
    }).eq("id", payment.id);

    // ── Auto-approve immediately ──────────────────────────────────────────
    const result = await autoApprovePayment(db, payment.id);

    if (!result.approved && result.reason !== "already_approved") {
      console.error(`PhonePe auto-approve failed for ${payment.id}:`, result.reason);
    }

    return NextResponse.json({
      ok: true,
      payment_id: payment.id,
      approved: result.approved,
    });
  }

  if (state === "FAILED") {
    await db.from("payments").update({
      status: "pg_failed",
      phonepe_txn_id: phonepeTxnId,
    }).eq("id", payment.id);

    return NextResponse.json({ ok: true, state: "FAILED" });
  }

  // PENDING — PhonePe will retry webhook
  return NextResponse.json({ ok: true, state: "PENDING" });
}
