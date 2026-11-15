import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { verifyRazorpayPaymentSignature, fetchRazorpayPayment } from "@/lib/razorpay";
import { settleExtraFeeOrder } from "@/lib/services/extra-fee";

export const runtime = "nodejs";

/**
 * POST /api/extra-fee/verify — browser callback after Razorpay Checkout.
 * Signature proves the pair is genuine; the live payment is re-fetched for
 * capture state and amount. The Razorpay webhook is the safety net.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const orderId = String(body?.razorpay_order_id ?? "");
  const paymentId = String(body?.razorpay_payment_id ?? "");
  const signature = String(body?.razorpay_signature ?? "");
  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ success: false, error: "Missing payment verification fields" }, { status: 400 });
  }

  try {
    const db = createServiceClient();
    const { data: row } = await db.from("extra_fee_payments")
      .select("id, amount, status, student_id").eq("razorpay_order_id", orderId).maybeSingle();
    if (!row || row.student_id !== user.profileId) {
      return NextResponse.json({ success: false, error: "Payment order not found" }, { status: 404 });
    }
    if (row.status === "paid") return NextResponse.json({ success: true, verified: true, approved: true });

    if (!verifyRazorpayPaymentSignature({ orderId, paymentId, signature })) {
      return NextResponse.json({ success: false, verified: false, error: "Payment signature verification failed" }, { status: 400 });
    }

    const live = await fetchRazorpayPayment(paymentId);
    if (String(live.order_id) !== orderId) {
      return NextResponse.json({ success: false, error: "Payment details do not match the order" }, { status: 400 });
    }
    if (!(live.status === "captured" || live.captured)) {
      return NextResponse.json({ success: true, verified: true, approved: false, message: "Payment received. Confirming it now — this updates automatically." });
    }

    const result = await settleExtraFeeOrder(db, row, {
      paymentId, amountPaise: Number(live.amount),
      utr: live.acquirer_data?.rrn ?? live.acquirer_data?.bank_transaction_id ?? null,
    });
    if (result === "failed") {
      return NextResponse.json({ success: false, error: "Payment amount did not match. This has been flagged for review." }, { status: 400 });
    }
    return NextResponse.json({ success: true, verified: true, approved: true });
  } catch (e) {
    console.error("[extra-fee/verify]", e);
    return NextResponse.json({ success: false, error: "Unable to verify the payment right now." }, { status: 500 });
  }
}
