/**
 * POST /api/payments/cancel
 *
 * Lets a student voluntarily cancel their own in-progress Razorpay order
 * (status "pg_pending") instead of being forced to wait out the staleness
 * window before they can retry.
 *
 * The payment id is supplied by the page so cancellation always targets the
 * exact payment attempt the student is looking at. This prevents a newer
 * payment row/webhook from making the UI and cancel API disagree.
 */
import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, conflict, serverError } from "@/lib/api-response";
import { audit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const body = await req.json().catch(() => ({}));
    const paymentId = typeof body?.payment_id === "string" ? body.payment_id : "";
    if (!paymentId) return conflict("Payment attempt not specified.");

    const db = createServiceClient();
    const { data: payment, error: paymentError } = await db.from("payments")
      .select("id, status")
      .eq("id", paymentId)
      .eq("student_id", user!.profileId)
      .maybeSingle();

    if (paymentError) return serverError("Could not check payment status.");
    if (!payment) return conflict("Payment attempt not found.");
    if (payment.status !== "pg_pending") {
      if (payment.status === "approved") {
        return conflict("This payment is already approved. Please refresh the page.");
      }
      return conflict("This payment is no longer in progress. Please refresh the page.");
    }

    const { data: cancelled, error: updErr } = await db.from("payments")
      .update({ status: "pg_failed" })
      .eq("id", payment.id)
      .eq("student_id", user!.profileId)
      .eq("status", "pg_pending")
      .select("id")
      .maybeSingle();

    if (updErr) return serverError("Could not cancel payment.");
    if (!cancelled) return conflict("This payment is no longer in progress. Please refresh the page.");

    await audit("payment.pg_cancelled_by_student", "payment", payment.id, {
      student_id: user!.profileId,
    }, user!.profileId, "student");

    return ok({ cancelled: true });
  } catch (err) { console.error("[api/payments/cancel]", err);
    return serverError();
  }
}
