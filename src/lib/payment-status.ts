import type { SupabaseClient } from "@supabase/supabase-js";
import { checkCashfreeStatus } from "@/lib/cashfree";
import { autoApprovePayment } from "@/lib/auto-approve";
import { audit } from "@/lib/audit";

export interface CashfreeReconcileResult {
  status: "approved" | "submitted" | "pg_failed" | string;
  paid: boolean;
  amount: number;
  mismatch?: boolean;
  order_status?: string;
}

/**
 * Reconciles a Cashfree order against our own `payments` row — reads live
 * status from Cashfree and, if paid, marks the row submitted and runs
 * autoApprovePayment. Never trusts the browser's word that a payment
 * succeeded; Cashfree is the authority.
 *
 * Used by /api/cashfree/status/[orderId] — the route every order's
 * return_url points students at (pay/status/[merchantTxnId]/page.tsx calls
 * it directly; item #95 dropped the "legacy phonepe-named proxy" this used
 * to also be shared with, now that no PhonePe orders are ever created).
 * Pulled out to its own function specifically so this amount-match /
 * auto-approve logic has exactly one implementation, never duplicated.
 */
export async function reconcileCashfreeOrder(
  db: SupabaseClient,
  payment: { id: string; status: string; amount: number },
  orderId: string,
): Promise<CashfreeReconcileResult> {
  if (payment.status === "approved") {
    return { status: "approved", paid: true, amount: Number(payment.amount) };
  }

  const live = await checkCashfreeStatus(orderId);
  if (!live.success) {
    return { status: payment.status, paid: false, amount: Number(payment.amount) };
  }

  if (live.paid) {
    // A valid Cashfree order vouches for the sender, not for the amount
    // being what we asked for — same guard the webhook applies.
    const expected = Math.round(Number(payment.amount) * 100);
    const received = Math.round(Number(live.amount ?? 0) * 100);
    if (expected > 0 && received !== expected) {
      await audit("payment.amount_mismatch", "payment", payment.id, {
        gateway: "cashfree", orderId, expectedPaise: expected, receivedPaise: received,
      }, undefined, "system");
      await db.from("payments").update({
        status: "pg_failed",
        review_notes: `Amount mismatch: expected ₹${(expected / 100).toFixed(2)}, received ₹${(received / 100).toFixed(2)}`,
      }).eq("id", payment.id);
      return { status: "pg_failed", paid: false, amount: Number(payment.amount), mismatch: true };
    }

    if (payment.status !== "submitted") {
      await db.from("payments").update({
        status: "submitted",
        utr_number: live.bankReference || live.cfPaymentId || null,
        cashfree_payment_id: live.cfPaymentId || null,
        submitted_at: new Date().toISOString(),
      }).eq("id", payment.id);
    }
    const result = await autoApprovePayment(db, payment.id);
    return { status: result.approved ? "approved" : "submitted", paid: true, amount: Number(payment.amount) };
  }

  if (live.orderStatus === "EXPIRED" || live.orderStatus === "TERMINATED") {
    await db.from("payments").update({ status: "pg_failed" }).eq("id", payment.id);
    return { status: "pg_failed", paid: false, amount: Number(payment.amount) };
  }

  return { status: payment.status, paid: false, amount: Number(payment.amount), order_status: live.orderStatus };
}
