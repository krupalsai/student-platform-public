/**
 * POST /api/cashfree/initiate
 *
 * Creates a Cashfree order for the signed-in student and returns the
 * payment_session_id the checkout page needs.
 *
 * Flow: student → Cashfree checkout → Cashfree webhook → auto approval.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, conflict, serverError, tooManyRequests } from "@/lib/api-response";
import { createCashfreeOrder, checkCashfreeStatus, genCashfreeOrderId, isCashfreeConfigured } from "@/lib/cashfree";
import { checkRateLimit } from "@/lib/rate-limit";
import { getPaymentGateForBatch } from "@/lib/services/payment-gate";
import { audit } from "@/lib/audit";
import { logStudentEvent } from "@/lib/student-events";
import { isCashfreeEnabled } from "@/lib/services/payment-settings";
import { logSystemError } from "@/lib/system-errors";

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();

    if (!(await isCashfreeEnabled(db)) || !isCashfreeConfigured()) {
      // Auto-switch (owner order 31-Oct-2026): the pay page may be showing a
      // stale gateway after an admin flip. Tell the client which gateway IS
      // live so it can swap automatically instead of asking the student to
      // close/reopen the app.
      const { getActivePaymentGateway } = await import("@/lib/services/payment-settings");
      const active = await getActivePaymentGateway(db);
      return NextResponse.json(
        { success: false, error: "Cashfree payment is not configured yet.", code: "GATEWAY_CHANGED", active_gateway: active },
        { status: 409 }
      );
    }

    const rl = await checkRateLimit(db, `cf_initiate:${user!.profileId}`, 5, 10 * 60);
    if (!rl.allowed) return tooManyRequests("Too many payment attempts. Please wait a few minutes and try again.");

    const { data: approved } = await db.from("payments")
      .select("id").eq("student_id", user!.profileId).eq("status", "approved").maybeSingle();
    if (approved) return conflict("Your payment has already been approved.");

    // The amount charged must always be the fee of the batch shown on the
    // /pay page (sent as batch_slug by the checkout button), never silently
    // the fee of whatever batch the profile happens to be linked to — the
    // two differ in the admin preview (and on a stale /pay link), and
    // charging the profile's fee while displaying another batch's fee breaks
    // the "amount == set fee" rule. Same resolution as /api/create-order:
    // a profile linked to a different batch is rejected, an unlinked
    // complete profile is linked to the requested batch.
    const body = await req.json().catch(() => null);
    const requestedSlug = String(body?.batch_slug ?? "").trim();
    const { data: profile } = await db.from("profiles")
      .select("batch_id, phone, full_name, is_profile_complete").eq("id", user!.profileId).maybeSingle();
    if (!profile) return conflict("No active batch found. Complete your profile first.");
    let batchId = profile.batch_id ?? null;
    if (requestedSlug) {
      const { data: requestedBatch } = await db.from("batches")
        .select("id, slug, status").eq("slug", requestedSlug).maybeSingle();
      if (!requestedBatch || requestedBatch.status !== "active") return conflict("Batch not found.");
      if (batchId && batchId !== requestedBatch.id) return conflict("Your account is linked to a different batch.");
      if (!batchId) {
        if (!profile?.is_profile_complete) return conflict("No active batch found. Complete your profile first.");
        const { error: linkErr } = await db.from("profiles").update({ batch_id: requestedBatch.id }).eq("id", user!.profileId);
        if (linkErr) return conflict("No active batch found. Complete your profile first.");
        batchId = requestedBatch.id;
      }
    }
    if (!batchId) return conflict("No active batch found. Complete your profile first.");

    const { data: batch } = await db.from("batches")
      .select("id, fee_amount, status, slug, name").eq("id", batchId).maybeSingle();
    if (!batch) return conflict("Batch not found.");

    const gate = await getPaymentGateForBatch(db, batchId);
    if (!gate.open) return conflict(gate.message ?? "Payments are not open for your batch.");
    const amount = gate.fee!;

    const { data: pending } = await db.from("payments")
      .select("id, cashfree_order_id, created_at")
      .eq("student_id", user!.profileId).eq("status", "pg_pending")
      .not("cashfree_order_id", "is", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    if (pending?.cashfree_order_id) {
      const ageMs = Date.now() - new Date(pending.created_at).getTime();
      if (ageMs < 10 * 60 * 1000) {
        const live = await checkCashfreeStatus(pending.cashfree_order_id);
        if (live.success && live.paid) {
          return ok({ order_id: pending.cashfree_order_id, already_paid: true });
        }
        await db.from("payments").update({ status: "pg_failed" }).eq("id", pending.id);
      } else {
        await db.from("payments").update({ status: "pg_failed" }).eq("id", pending.id);
      }
    }

    const orderId = genCashfreeOrderId(user!.profileId);
    const result = await createCashfreeOrder({
      orderId,
      amount,
      studentId: user!.profileId,
      studentName: profile.full_name,
      phone: profile.phone,
      note: `${batch.name ?? "Batch"} registration fee`,
    });

    if (!result.success || !result.paymentSessionId) {
      // Bug #27/#35 class, confirmed live via a real test call (item #179):
      // this used to hand Cashfree's own raw account-status error text
      // straight to the client (`serverError(result.error)`), and named the
      // gateway in the fallback text — both a rule-27 leak and a rule-7
      // violation in one line. Full detail stays in the server log + the
      // AI-triage pipeline; the student only ever sees a generic message.
      console.error("[cashfree/initiate] order failed:", result.error);
      await logSystemError(db, "api/cashfree/initiate", new Error(result.error ?? "Cashfree order creation failed"), {
        student_id: user!.profileId, batch_id: batch.id,
      });
      return serverError("Payment could not be started. Please try again shortly.");
    }

    const { data: pay, error: pErr } = await db.from("payments").insert({
      student_id: user!.profileId,
      batch_id: batch.id,
      amount,
      status: "pg_pending",
      payment_method: "cashfree",
      cashfree_order_id: orderId,
    }).select("id").single();

    if (pErr || !pay) {
      console.error("[cashfree/initiate] payment row insert failed:", pErr);
      return serverError("Could not create payment record.");
    }

    await audit("payment.pg_initiated", "payment", pay.id, {
      gateway: "cashfree", student_id: user!.profileId, order_id: orderId, amount, batch_id: batch.id,
    }, user!.profileId, "student");
    await logStudentEvent(db, {
      student_id: user!.profileId,
      batch_id: batch.id,
      event_type: "payment.initiated",
      page: `/pay/${batch.slug}`,
      metadata: { gateway: "cashfree", order_id: orderId, amount },
    });

    const { CASHFREE_MODE } = await import("@/lib/cashfree");
    return ok({ order_id: orderId, payment_session_id: result.paymentSessionId, mode: CASHFREE_MODE });
  } catch (e) {
    console.error("[cashfree/initiate]", e);
    return serverError();
  }
}
