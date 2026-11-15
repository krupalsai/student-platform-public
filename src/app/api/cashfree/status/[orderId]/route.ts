/**
 * GET /api/cashfree/status/[orderId]
 *
 * Polled by the return page while the student comes back from Cashfree.
 *
 * This is also the reconciliation path, not just a read: the student's browser
 * often returns before the webhook lands, and a webhook can be missed
 * altogether. So when Cashfree says PAID and our row hasn't caught up, this
 * approves it here rather than leaving the student waiting on an event that
 * may never arrive. Cashfree is the authority — the browser's return is only a
 * hint that it is worth asking.
 *
 * `params` is a Promise under Next 15 (bug #34).
 */

import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, notFound } from "@/lib/api-response";
import { reconcileCashfreeOrder } from "@/lib/payment-status";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  const { orderId } = await ctx.params;
  const db = createServiceClient();

  const { data: payment } = await db.from("payments")
    .select("id, status, student_id, amount")
    .eq("cashfree_order_id", orderId).maybeSingle();

  if (!payment) return notFound("Payment");
  // A student may only read their own payment.
  if (payment.student_id !== user!.profileId) return forbidden();

  const result = await reconcileCashfreeOrder(db, payment, orderId);
  return ok(result);
}
