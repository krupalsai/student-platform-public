/**
 * GET /api/razorpay/status/[orderId]
 *
 * Polled by /pay/status while /api/razorpay/verify (fired right after
 * Checkout.js closes) or the webhook catches up. Unlike Cashfree's status
 * route, this doesn't re-hit the gateway API itself — Checkout.js's own
 * handler() already calls /verify synchronously with a signed result, so by
 * the time this polls, either that call already landed or the webhook will.
 * This just reads our row.
 *
 * `params` is a Promise under Next 15 (bug #34, same as Cashfree's route).
 */

import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, notFound } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  const { orderId } = await ctx.params;
  const db = createServiceClient();

  const { data: payment } = await db.from("payments")
    .select("status, student_id, amount")
    .eq("razorpay_order_id", orderId).maybeSingle();

  if (!payment) return notFound("Payment");
  if (payment.student_id !== user!.profileId) return forbidden();

  return ok({ status: payment.status, amount: Number(payment.amount) });
}
