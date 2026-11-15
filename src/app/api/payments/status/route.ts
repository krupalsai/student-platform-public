import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { getLatestPaymentRaw } from "@/lib/services/payments";
import { reconcileRazorpayOrder } from "@/lib/razorpay-reconcile";
import { logSystemError } from "@/lib/system-errors";

export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();

    // Reconcile recent Razorpay attempts, not only the newest row. A student
    // can complete payment on order A and then create a second pending order B
    // before the callback/webhook reaches us. In that case B must not shadow
    // the captured payment on A.
    // Only the few that can realistically still be settling: the newest 3
    // pending orders, plus failed ones from the last 3 days. Older abandoned
    // orders were checked on every app open — up to 10 Razorpay calls one
    // after another (4-5 s) for a student with several old attempts. The
    // 15-minute self-watch sweep still settles anything older on its own.
    const recentFailedSince = new Date(Date.now() - 3 * 86400_000).toISOString();
    const { data: candidates, error: candidateError } = await db
      .from("payments")
      .select("id, status, amount, payment_method, razorpay_order_id, created_at")
      .eq("student_id", user!.profileId)
      .eq("payment_method", "razorpay")
      .in("status", ["pg_pending", "pg_failed"])
      .or(`status.eq.pg_pending,created_at.gte.${recentFailedSince}`)
      .order("created_at", { ascending: false })
      .limit(3);

    if (candidateError) {
      console.error("[api/payments/status] candidate lookup failed", candidateError);
    } else {
      // In parallel: they are independent orders, and waiting for each in turn
      // is what made this call slow.
      await Promise.all((candidates ?? []).filter((c) => c.razorpay_order_id).map(async (candidate) => {
        try {
          await reconcileRazorpayOrder(db, {
            id: candidate.id,
            status: candidate.status,
            amount: Number(candidate.amount),
            razorpay_order_id: candidate.razorpay_order_id,
          });
        } catch (reconcileError) {
          console.error("[api/payments/status] Razorpay reconciliation failed", {
            paymentId: candidate.id,
            error: reconcileError,
          });
          await logSystemError(db, "api/payments/status:reconcile", reconcileError, { paymentId: candidate.id });
        }
      }));
    }

    const refreshed = await getLatestPaymentRaw(db, user!.profileId);
    return ok(refreshed);
  } catch (err) {
    console.error("[api/payments/status]", err);
    await logSystemError(createServiceClient(), "api/payments/status", err);
    return serverError();
  }
}
