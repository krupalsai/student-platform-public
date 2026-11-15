/**
 * POST /api/phonepe/initiate
 *
 * Called by the student pay page to create a PhonePe payment order.
 * Returns the checkout URL to redirect the student to.
 *
 * Flow:
 *   1. Student hits "Pay Now" on the pay page while PhonePe is the active gateway
 *   2. Frontend calls this route
 *   3. We create a PhonePe order + store a pending payment row in DB
 *   4. Return the PhonePe checkout URL to frontend
 *   5. Student completes payment on PhonePe's hosted page
 *   6. PhonePe calls our webhook (/api/phonepe/webhook) → auto-approve
 *
 * Security: rate-limited to 5 attempts per student per 10 minutes to
 * prevent spam/abuse of the payment-order-creation endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, conflict, serverError, tooManyRequests } from "@/lib/api-response";
import { createPhonePeOrder, checkPhonePeStatus } from "@/lib/phonepe";
import { checkRateLimit } from "@/lib/rate-limit";
import { getPaymentGateForBatch } from "@/lib/services/payment-gate";
import { isPhonePeEnabled } from "@/lib/services/payment-settings";
import { audit } from "@/lib/audit";
import { logStudentEvent } from "@/lib/student-events";
import { logSystemError } from "@/lib/system-errors";

/** Generate a unique merchant transaction ID */
function genMerchantTxnId(studentId: string): string {
  const suffix = studentId.replace(/-/g, "").slice(-8).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SP-${suffix}-${ts}-${rand}`;
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();

    // ── Gateway switched off ────────────────────────────────────────────────
    // Checked before anything else: when PhonePe is off there is no point
    // spending a rate-limit slot or a DB round-trip. This is the ONLY thing
    // that decides whether this route runs at all — see item #178's
    // switchable-gateway design. It deliberately does NOT flip any OTHER
    // gateway's switch on failure (a past version silently turned Manual UPI
    // back on behind the admin's back on any PhonePe error — exactly the
    // kind of hidden auto-behaviour the admin now explicitly wants gone).
    if (!(await isPhonePeEnabled(db))) {
      // Auto-switch (owner order 31-Oct-2026): tell the client which gateway
      // IS live so the pay page can swap automatically instead of asking the
      // student to close/reopen the app.
      const { getActivePaymentGateway } = await import("@/lib/services/payment-settings");
      const active = await getActivePaymentGateway(db);
      return NextResponse.json(
        { success: false, error: "PhonePe payment is not enabled right now.", code: "GATEWAY_CHANGED", active_gateway: active },
        { status: 409 }
      );
    }

    // ── Rate limit: max 5 payment-initiation attempts per student per 10 min ──
    // Stops accidental double-taps and any abuse/spam of this endpoint.
    const rl = await checkRateLimit(db, `pg_initiate:${user!.profileId}`, 5, 10 * 60);
    if (!rl.allowed) {
      return tooManyRequests(
        "Too many payment attempts. Please wait a few minutes and try again."
      );
    }

    // ── Block if already approved ──────────────────────────────────────────
    const { data: approved } = await db.from("payments")
      .select("id")
      .eq("student_id", user!.profileId)
      .eq("status", "approved")
      .maybeSingle();
    if (approved) return conflict("Your payment has already been approved.");

    // The amount charged must always be the fee of the batch shown on the
    // /pay page (sent as batch_slug by the checkout button), never silently
    // the fee of whatever batch the profile happens to be linked to — the
    // two differ in the admin preview (and on a stale /pay link), and
    // charging the profile's fee while displaying another batch's fee breaks
    // the "amount == set fee" rule. Same resolution as /api/create-order.
    const body = await req.json().catch(() => null);
    const requestedSlug = String(body?.batch_slug ?? "").trim();
    const { data: profile } = await db.from("profiles")
      .select("batch_id, phone, is_profile_complete")
      .eq("id", user!.profileId)
      .maybeSingle();
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
      .select("id, fee_amount, status, slug, name")
      .eq("id", batchId)
      .maybeSingle();
    if (!batch) return conflict("Batch not found.");

    // ONE gate, shared with every other payment route and with the status the
    // student is reading: active batch, member minimum reached, not closed by
    // an admin, fee set. Read from the database, never the request.
    const gate = await getPaymentGateForBatch(db, batchId);
    if (!gate.open) return conflict(gate.message ?? "Payments are not open for your batch.");

    const amountPaise = Math.round(gate.fee! * 100);

    // ── Check for existing pending PhonePe order (avoid duplicates) ────────
    const { data: existingPending } = await db.from("payments")
      .select("id, phonepe_merchant_txn_id, status, created_at")
      .eq("student_id", user!.profileId)
      .eq("status", "pg_pending")
      .not("phonepe_merchant_txn_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Reuse existing pending order if < 10 minutes old — but only if PhonePe
    // itself still considers it PENDING. A row can still say "pg_pending" in
    // our DB while the order is actually dead on PhonePe's side (student
    // backed out / hit "Cancel Payment?" on the hosted checkout, or the
    // order simply expired). Calling checkout/v2/pay again with an ID
    // PhonePe already closed out does not resurrect it — it just hands the
    // student back into the same broken order. Verifying live status first
    // ensures we only ever reuse an order that can actually still be paid.
    if (existingPending?.phonepe_merchant_txn_id) {
      const ageMs = Date.now() - new Date(existingPending.created_at).getTime();
      if (ageMs < 10 * 60 * 1000) {
        const liveStatus = await checkPhonePeStatus(existingPending.phonepe_merchant_txn_id);

        if (liveStatus.success && liveStatus.state === "PENDING") {
          const sessionTokenReuse = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
          const result = await createPhonePeOrder({
            merchantTransactionId: existingPending.phonepe_merchant_txn_id,
            amount: amountPaise,
            studentId: user!.profileId,
            batchSlug: batch.slug ?? "",
            mobileNumber: profile.phone ?? undefined,
            sessionToken: sessionTokenReuse || undefined,
          });
          if (result.success) {
            return ok({
              merchant_txn_id: result.merchantTransactionId,
              checkout_url: result.checkoutPageUrl,
            });
          }
        } else {
          // Order is done (COMPLETED elsewhere, FAILED, or PhonePe couldn't
          // find/confirm it) — reflect that in our own row instead of
          // silently leaving it "pg_pending" forever, then fall through to
          // create a brand-new order below.
          const newStatus = liveStatus.state === "COMPLETED" ? "submitted" : "pg_failed";
          await db.from("payments").update({ status: newStatus }).eq("id", existingPending.id);
        }
      }
    }

    // ── Create new PhonePe order ───────────────────────────────────────────
    const merchantTxnId = genMerchantTxnId(user!.profileId);

    // Pass the session token so the status page can authenticate on a
    // browser that doesn't share localStorage with wherever the checkout ran.
    const sessionToken = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";

    const result = await createPhonePeOrder({
      merchantTransactionId: merchantTxnId,
      amount: amountPaise,
      studentId: user!.profileId,
      batchSlug: batch.slug ?? "",
      mobileNumber: profile.phone ?? undefined,
      sessionToken: sessionToken || undefined,
    });

    if (!result.success) {
      console.error("PhonePe order failed:", result.error);
      await logSystemError(db, "api/phonepe/initiate", new Error(result.error ?? "PhonePe order creation failed"), {
        student_id: user!.profileId, batch_id: batch.id,
      });
      return serverError("Payment could not be started. Please try again shortly.");
    }

    // ── Insert payment row with pg_pending status ──────────────────────────
    const { data: pay, error: pErr } = await db.from("payments").insert({
      student_id: user!.profileId,
      batch_id: batch.id,
      amount: Number(batch.fee_amount),
      status: "pg_pending",
      payment_method: "phonepe",
      phonepe_merchant_txn_id: merchantTxnId,
    }).select("id").single();

    if (pErr || !pay) {
      console.error("Payment row insert failed:", pErr);
      return serverError("Could not create payment record.");
    }

    await audit("payment.pg_initiated", "payment", pay.id, {
      gateway: "phonepe", student_id: user!.profileId,
      merchant_txn_id: merchantTxnId, amount: Number(batch.fee_amount), batch_id: batch.id,
    }, user!.profileId, "student");
    await logStudentEvent(db, {
      student_id: user!.profileId,
      batch_id:   batch.id,
      event_type: "payment.initiated",
      page:       `/pay/${batch.slug}`,
      metadata:   { gateway: "phonepe", merchant_txn_id: merchantTxnId, amount: Number(batch.fee_amount) },
    });

    if (!result.checkoutPageUrl) {
      console.error("PhonePe order succeeded but returned no checkout URL:", JSON.stringify(result));
      await logSystemError(db, "api/phonepe/initiate", new Error("PhonePe order succeeded but returned no checkoutPageUrl"), {
        merchant_txn_id: merchantTxnId,
      });
    }

    return ok({
      merchant_txn_id: merchantTxnId,
      checkout_url: result.checkoutPageUrl,
    });

  } catch (e: any) {
    console.error("PhonePe initiate error:", e);
    return serverError();
  }
}
