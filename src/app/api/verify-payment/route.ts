import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { fetchRazorpayPayment } from "@/lib/razorpay";
import { autoApprovePayment } from "@/lib/auto-approve";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

function signaturesMatch(expected: string, received: string) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const paymentId = String(body?.razorpay_payment_id ?? "");
  const returnedOrderId = String(body?.razorpay_order_id ?? "");
  const receivedSignature = String(body?.razorpay_signature ?? "");
  if (!paymentId || !returnedOrderId || !receivedSignature) {
    return NextResponse.json({ success: false, error: "Missing payment verification fields" }, { status: 400 });
  }

  try {
    const db = createServiceClient();
    const { data: paymentRow } = await db.from("payments")
      .select("id, status, student_id, amount, batch_id, razorpay_order_id")
      .eq("razorpay_order_id", returnedOrderId)
      .maybeSingle();
    if (!paymentRow || paymentRow.student_id !== user.profileId) {
      return NextResponse.json({ success: false, error: "Payment order not found" }, { status: 404 });
    }
    if (paymentRow.status === "approved") {
      return NextResponse.json({ success: true, verified: true, approved: true, already_approved: true });
    }

    const serverOrderId = String(paymentRow.razorpay_order_id ?? "");
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!serverOrderId || !secret) throw new Error("Razorpay verification is not configured");

    const expectedSignature = crypto.createHmac("sha256", secret)
      .update(`${serverOrderId}|${paymentId}`)
      .digest("hex");
    if (!signaturesMatch(expectedSignature, receivedSignature)) {
      await db.from("payments").update({ status: "pg_failed", review_notes: "Razorpay signature verification failed." })
        .eq("id", paymentRow.id).eq("status", "pg_pending");
      await audit("payment.pg_initiated", "payment", paymentRow.id,
        { gateway: "razorpay", event: "signature_failed", order_id: serverOrderId, payment_id: paymentId }, user.profileId, "student");
      return NextResponse.json({ success: false, verified: false, error: "Payment signature verification failed" }, { status: 400 });
    }

    const razorpayPayment = await fetchRazorpayPayment(paymentId);
    const expectedPaise = Math.round(Number(paymentRow.amount) * 100);
    const receivedPaise = Number(razorpayPayment?.amount ?? 0);
    if (String(razorpayPayment?.order_id ?? "") !== serverOrderId ||
        receivedPaise !== expectedPaise || String(razorpayPayment?.currency ?? "INR") !== "INR") {
      await db.from("payments").update({
        status: "pg_failed",
        razorpay_payment_id: paymentId,
        review_notes: `Razorpay payment/order/amount mismatch. Expected ₹${Number(paymentRow.amount).toFixed(2)}.`,
      }).eq("id", paymentRow.id).eq("status", "pg_pending");
      return NextResponse.json({ success: false, verified: true, error: "Payment details do not match the order" }, { status: 400 });
    }

    const captured = razorpayPayment.status === "captured" || razorpayPayment.captured === true;
    const rrn = String(razorpayPayment.acquirer_data?.rrn ?? razorpayPayment.acquirer_data?.bank_transaction_id ?? paymentId);
    await db.from("payments").update({
      status: captured ? "submitted" : "pg_pending",
      razorpay_payment_id: paymentId,
      utr_number: rrn || null,
      submitted_at: captured ? new Date().toISOString() : null,
      review_notes: captured ? null : "Razorpay signature verified; payment is not captured yet.",
    }).eq("id", paymentRow.id).eq("status", "pg_pending");

    await audit("payment.pg_initiated", "payment", paymentRow.id,
      { gateway: "razorpay", event: "verified", order_id: serverOrderId, payment_id: paymentId, captured, amount: paymentRow.amount },
      user.profileId, "student");

    if (!captured) return NextResponse.json({ success: true, verified: true, captured: false, approved: false, message: "Payment verified but is awaiting capture." });
    const result = await autoApprovePayment(db, paymentRow.id);
    return NextResponse.json({ success: true, verified: true, captured: true, approved: result.approved, reason: result.reason });
  } catch (e: any) {
    console.error("[razorpay/verify-payment]", e);
    const status = Number(e?.statusCode ?? e?.response?.statusCode ?? 500);
    return NextResponse.json({ success: false, error: "Unable to verify the payment right now." }, { status: status === 401 ? 401 : 500 });
  }
}
