import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { isRazorpayEnabled } from "@/lib/services/payment-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { createRazorpayOrder } from "@/lib/razorpay";
import { getExtraFeeState } from "@/lib/services/extra-fee";
import { logSystemError } from "@/lib/system-errors";

export const runtime = "nodejs";

/** POST /api/extra-fee/create-order — Razorpay order for the batch's second payment. Amount is always server-side. */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  try {
    const db = createServiceClient();
    if (!(await isRazorpayEnabled(db))) {
      return NextResponse.json({ success: false, error: "Payments are currently unavailable. Please try again shortly." }, { status: 409 });
    }
    const rl = await checkRateLimit(db, `extra_fee_create:${user.profileId}`, 5, 10 * 60);
    if (!rl.allowed) return NextResponse.json({ success: false, error: "Too many payment attempts. Please wait a few minutes." }, { status: 429 });

    const state = await getExtraFeeState(db, user.profileId);
    if (state.paid) return NextResponse.json({ success: false, error: "This payment is already done." }, { status: 409 });
    if (!state.due || !state.amount || !state.batchId) {
      return NextResponse.json({ success: false, error: "Nothing to pay right now." }, { status: 409 });
    }

    const amountPaise = Math.round(state.amount * 100);
    const receipt = `sx_${user.profileId.replace(/-/g, "").slice(-12)}_${Date.now().toString(36)}`.slice(0, 40);
    const order = await createRazorpayOrder({
      amount: amountPaise, currency: "INR", receipt,
      notes: { student_id: user.profileId, batch_id: state.batchId, kind: "extra_fee" },
    });
    const { error: insErr } = await db.from("extra_fee_payments").insert({
      student_id: user.profileId, batch_id: state.batchId, amount: state.amount,
      status: "pending", razorpay_order_id: order.id,
    });
    if (insErr) return NextResponse.json({ success: false, error: "Could not create the payment record." }, { status: 500 });

    const keyId = process.env.RAZORPAY_KEY_ID;
    if (!keyId) return NextResponse.json({ success: false, error: "Payment could not be started. Please try again shortly." }, { status: 500 });
    return NextResponse.json({ success: true, order_id: order.id, amount: amountPaise, currency: "INR", key_id: keyId });
  } catch (e) {
    console.error("[extra-fee/create-order]", e);
    await logSystemError(createServiceClient(), "api/extra-fee/create-order", e);
    return NextResponse.json({ success: false, error: "Payment could not be started. Please try again shortly." }, { status: 500 });
  }
}
