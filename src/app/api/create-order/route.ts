import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { getPaymentGateForBatch } from "@/lib/services/payment-gate";
import { isRazorpayEnabled } from "@/lib/services/payment-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import { createRazorpayOrder } from "@/lib/razorpay";
import { logSystemError } from "@/lib/system-errors";

export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  try {
    const db = createServiceClient();
    if (!(await isRazorpayEnabled(db))) {
      // Auto-switch (owner order 31-Oct-2026): tell the client which gateway
      // IS live so the pay page can swap automatically instead of asking the
      // student to close/reopen the app.
      const { getActivePaymentGateway } = await import("@/lib/services/payment-settings");
      const active = await getActivePaymentGateway(db);
      return NextResponse.json({ success: false, error: "Payments are currently unavailable. Please try again shortly.", code: "GATEWAY_CHANGED", active_gateway: active }, { status: 409 });
    }
    const rl = await checkRateLimit(db, `razorpay_create:${user.profileId}`, 5, 10 * 60);
    if (!rl.allowed) return NextResponse.json({ success: false, error: "Too many payment attempts. Please wait a few minutes." }, { status: 429 });
    const { data: approved } = await db.from("payments").select("id").eq("student_id", user.profileId).eq("status", "approved").maybeSingle();
    if (approved) return NextResponse.json({ success: false, error: "Your payment has already been approved." }, { status: 409 });

    const body = await req.json().catch(() => ({}));
    const requestedSlug = typeof body?.batch_slug === "string" ? body.batch_slug.trim() : "";
    const { data: profile } = await db.from("profiles").select("batch_id,is_profile_complete").eq("id", user.profileId).maybeSingle();

    let batchId: string | null = profile?.batch_id ?? null;
    if (requestedSlug) {
      const { data: requestedBatch } = await db.from("batches")
        .select("id")
        .eq("slug", requestedSlug)
        .eq("status", "active")
        .maybeSingle();
      if (!requestedBatch) return NextResponse.json({ success: false, error: "This batch is no longer active." }, { status: 409 });
      if (batchId && batchId !== requestedBatch.id) return NextResponse.json({ success: false, error: "Your account is linked to a different batch." }, { status: 409 });
      if (!batchId && profile?.is_profile_complete) {
        const { error: linkErr } = await db.from("profiles")
          .update({ batch_id: requestedBatch.id })
          .eq("id", user.profileId)
          .is("batch_id", null);
        if (linkErr) return NextResponse.json({ success: false, error: "Could not link your registration to this batch." }, { status: 500 });
        batchId = requestedBatch.id;
      }
    }

    if (!batchId) return NextResponse.json({ success: false, error: "No active batch found. Complete your registration first." }, { status: 409 });
    const gate = await getPaymentGateForBatch(db, batchId);
    if (!gate.open || !gate.fee) return NextResponse.json({ success: false, error: gate.message ?? "Payments are not open for your batch." }, { status: 409 });
    const amount = Math.round(Number(gate.fee) * 100);
    if (amount < 100) return NextResponse.json({ success: false, error: "The configured payment amount is below the minimum. Contact your admin." }, { status: 400 });
    const receipt = `sp_${user.profileId.replace(/-/g, "").slice(-12)}_${Date.now().toString(36)}`.slice(0, 40);
    const order = await createRazorpayOrder({ amount, currency: "INR", receipt, notes: { student_id: user.profileId, batch_id: batchId } });
    const { data: payment, error: pErr } = await db.from("payments").insert({ student_id: user.profileId, batch_id: batchId, amount: Number(gate.fee), status: "pg_pending", payment_method: "razorpay", razorpay_order_id: order.id }).select("id").single();
    if (pErr || !payment) return NextResponse.json({ success: false, error: "Could not create the payment record." }, { status: 500 });

    // Use the same server-side Razorpay account that created the order.
    // This prevents a stale/mismatched NEXT_PUBLIC_RAZORPAY_KEY_ID from
    // opening checkout against a different Razorpay account or mode.
    const keyId = process.env.RAZORPAY_KEY_ID;
    if (!keyId) return NextResponse.json({ success: false, error: "Payment could not be started. Please try again shortly." }, { status: 500 });
    return NextResponse.json({ success: true, order_id: order.id, amount, currency: "INR", key_id: keyId });
  } catch (e) {
    // Full detail (gateway auth failures, invalid keys, etc.) stays in the
    // server log for diagnosis — never in the client response. Rule 7 (never
    // name a payment gateway to a student) and the bug #27 class (never
    // return a raw internal/gateway error message) both apply here.
    const gatewayError = e as Error & { statusCode?: number };
    console.error("[create-order]", e);
    await logSystemError(createServiceClient(), "api/create-order", e);
    const isGatewayAuth = gatewayError?.statusCode === 401 || /authentication failed|invalid.*key|api key/i.test(gatewayError?.message ?? "");
    return NextResponse.json({
      success: false,
      error: "Payment could not be started. Please try again shortly.",
    }, { status: isGatewayAuth ? 502 : 500 });
  }
}
