/**
 * POST /api/cashfree/webhook
 *
 * Cashfree calls this after every payment attempt. Set it as the webhook URL
 * in the Cashfree dashboard (Developers → Webhooks) — it is also sent as
 * order_meta.notify_url on every order.
 *
 * On PAYMENT_SUCCESS_WEBHOOK:
 *   → marks the payment submitted with the bank reference as its UTR
 *   → auto-approves via autoApprovePayment() (sends the Telegram invite)
 *
 * Security posture:
 *   - HMAC signature verified before anything is read from the body
 *   - replay protection via webhook_events (provider + checksum)
 *   - amount-match validation: a signed event whose amount differs from what
 *     we recorded at order time is flagged for manual review, never approved
 *   - unverified calls are rejected 401 and nothing is processed
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { verifyCashfreeWebhook } from "@/lib/cashfree";
import { autoApprovePayment } from "@/lib/auto-approve";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const rawBody   = await req.text();
  const signature = req.headers.get("x-webhook-signature");
  const timestamp = req.headers.get("x-webhook-timestamp");

  if (!verifyCashfreeWebhook(rawBody, signature, timestamp)) {
    console.warn("[cashfree/webhook] invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const type    = String(body?.type ?? "").toUpperCase();
  const order   = body?.data?.order   ?? {};
  const payment = body?.data?.payment ?? {};

  const orderId = String(order.order_id ?? "");
  const status  = String(payment.payment_status ?? "").toUpperCase();
  const amount  = Number(payment.payment_amount ?? order.order_amount ?? 0);
  const cfPayId = String(payment.cf_payment_id ?? "");
  const bankRef = String(payment.bank_reference ?? "");

  if (!orderId) {
    // Cashfree also sends non-payment events (refunds, disputes, settlements).
    // Acknowledge them so they aren't retried forever, but don't act on them.
    return NextResponse.json({ ok: true, note: "no_order_id", type });
  }

  const db = createServiceClient();

  // ── Replay protection ────────────────────────────────────────────────────
  const checksum = signature ?? "";
  const { data: replay } = await db.from("webhook_events")
    .select("id").eq("provider", "cashfree").eq("checksum", checksum).maybeSingle();
  if (replay) {
    console.warn(`[cashfree/webhook] replay ignored for ${orderId}`);
    return NextResponse.json({ ok: true, note: "replay_ignored" });
  }
  // Awaited, not fire-and-forget: on Vercel an unawaited insert is killed when
  // the lambda freezes, which would silently disable replay protection.
  const { error: logErr } = await db.from("webhook_events")
    .insert({ provider: "cashfree", merchant_txn_id: orderId, checksum });
  if (logErr?.code === "23505") {
    // Duplicate-key on (provider, checksum): the same signed event arrived
    // twice at once and both deliveries passed the replay check above
    // before either inserted (confirmed live 5 Nov 2026 — the old code only
    // logged it and processed the payment twice). The first delivery owns
    // this event; acknowledge and stop — the already_approved guard below
    // is the backstop, not the plan.
    console.warn(`[cashfree/webhook] duplicate event ignored for ${orderId}`);
    return NextResponse.json({ ok: true, note: "already_processed" });
  }
  if (logErr) console.error("[cashfree/webhook] event log failed:", logErr.message);

  // ── Find our row ─────────────────────────────────────────────────────────
  const { data: paymentRow } = await db.from("payments")
    .select("id, status, student_id, amount")
    .eq("cashfree_order_id", orderId).maybeSingle();

  if (!paymentRow) {
    console.warn(`[cashfree/webhook] no payment found for order ${orderId}`);
    return NextResponse.json({ ok: true, note: "payment_not_found" });
  }
  if (paymentRow.status === "approved") {
    return NextResponse.json({ ok: true, note: "already_approved" });
  }

  await audit("payment.pg_webhook", "payment", paymentRow.id, {
    gateway: "cashfree", type, status, orderId, cfPayId, amount, bankRef,
  }, undefined, "system");

  // ── Not a success event ──────────────────────────────────────────────────
  if (!(type.includes("SUCCESS") || status === "SUCCESS")) {
    if (status === "FAILED" || type.includes("FAILED")) {
      await db.from("payments").update({
        status: "pg_failed",
        cashfree_payment_id: cfPayId || null,
      }).eq("id", paymentRow.id);
    }
    return NextResponse.json({ ok: true, note: "not_success", type, status });
  }

  // ── Amount-match validation ──────────────────────────────────────────────
  // A valid signature vouches for the sender, not for the amount being what we
  // asked for. Compared in paise so floating-point rupees can't drift.
  const expected = Math.round(Number(paymentRow.amount) * 100);
  const received = Math.round(amount * 100);
  if (expected > 0 && received !== expected) {
    console.error(`[cashfree/webhook] amount mismatch for ${orderId}: expected ${expected}p, got ${received}p`);
    await audit("payment.amount_mismatch", "payment", paymentRow.id, {
      gateway: "cashfree", orderId, expectedPaise: expected, receivedPaise: received,
    }, undefined, "system");
    await db.from("payments").update({
      status: "pg_failed",
      cashfree_payment_id: cfPayId || null,
      review_notes: `Amount mismatch: expected ₹${(expected / 100).toFixed(2)}, received ₹${(received / 100).toFixed(2)}`,
    }).eq("id", paymentRow.id);
    return NextResponse.json({ ok: true, note: "amount_mismatch_flagged" });
  }

  // ── Success → submitted, then auto-approve ───────────────────────────────
  await db.from("payments").update({
    status: "submitted",
    utr_number: bankRef || cfPayId || null,
    cashfree_payment_id: cfPayId || null,
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
