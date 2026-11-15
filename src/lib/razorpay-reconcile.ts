import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchRazorpayOrderPayments } from "@/lib/razorpay";
import { autoApprovePayment } from "@/lib/auto-approve";
import { audit } from "@/lib/audit";

export async function reconcileRazorpayOrder(
  db: SupabaseClient,
  payment: { id: string; status: string; amount: number; razorpay_order_id?: string | null },
): Promise<{ status: string; paid: boolean; mismatch?: boolean }> {
  if (payment.status === "approved") return { status: "approved", paid: true };
  if (!payment.razorpay_order_id) return { status: payment.status, paid: false };

  const live = await fetchRazorpayOrderPayments(payment.razorpay_order_id);
  const expectedPaise = Math.round(Number(payment.amount) * 100);
  const captured = live.items.filter((item) => item.captured && item.status === "captured");
  const match = captured.find((item) => Math.round(Number(item.amount)) === expectedPaise);

  if (match) {
    await db.from("payments").update({
      status: "submitted",
      razorpay_payment_id: match.id,
      utr_number: match.acquirer_data?.bank_transaction_id || match.acquirer_data?.rrn || null,
      submitted_at: new Date().toISOString(),
    }).eq("id", payment.id);

    const result = await autoApprovePayment(db, payment.id);
    return { status: result.approved ? "approved" : "submitted", paid: true };
  }

  if (captured.length > 0) {
    const receivedPaise = Math.round(Number(captured[0].amount));
    await audit("payment.amount_mismatch", "payment", payment.id, {
      gateway: "razorpay",
      orderId: payment.razorpay_order_id,
      expectedPaise,
      receivedPaise,
    }, undefined, "system");
    await db.from("payments").update({
      status: "pg_failed",
      razorpay_payment_id: captured[0].id,
      review_notes: `Amount mismatch: expected ₹${(expectedPaise / 100).toFixed(2)}, received ₹${(receivedPaise / 100).toFixed(2)}`,
    }).eq("id", payment.id);
    return { status: "pg_failed", paid: false, mismatch: true };
  }

  return { status: payment.status, paid: false };
}

/**
 * Scheduled sweep (called from /api/cron/self-watch every 15 minutes).
 *
 * Without it a stuck Razorpay order was only re-checked when THAT student
 * opened the app (/api/payments/status). A student who paid, lost the
 * callback and never came back stayed "unpaid" forever, with nobody to fix
 * it by hand. Now:
 *   - paid at Razorpay           → approved through autoApprovePayment
 *   - still unpaid after 48h     → pg_failed, so the student can simply pay
 *                                  again (pg_failed is still re-checked by
 *                                  /api/payments/status, so this is reversible)
 * Bounded per run so a slow Razorpay never stalls the cron.
 */
export async function sweepStaleRazorpayOrders(
  db: SupabaseClient,
  opts: { limit?: number; expireAfterHours?: number } = {},
): Promise<{ checked: number; approved: number; expired: number; errors: number }> {
  const limit = opts.limit ?? 20;
  const expireMs = (opts.expireAfterHours ?? 48) * 3_600_000;
  const out = { checked: 0, approved: 0, expired: 0, errors: 0 };

  const { data: rows, error } = await db
    .from("payments")
    .select("id, status, amount, razorpay_order_id, created_at")
    .eq("payment_method", "razorpay")
    .eq("status", "pg_pending")
    .not("razorpay_order_id", "is", null)
    .lt("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[razorpay-sweep] lookup failed:", error.message);
    return out;
  }

  for (const row of rows ?? []) {
    out.checked++;
    try {
      const r = await reconcileRazorpayOrder(db, {
        id: row.id,
        status: row.status,
        amount: Number(row.amount),
        razorpay_order_id: row.razorpay_order_id,
      });
      if (r.paid) {
        out.approved++;
        continue;
      }
      if (!r.mismatch && Date.now() - new Date(row.created_at).getTime() > expireMs) {
        await db.from("payments")
          .update({ status: "pg_failed", review_notes: "No payment received at the gateway within 48 hours — the student can pay again." })
          .eq("id", row.id)
          .eq("status", "pg_pending");
        out.expired++;
      }
    } catch (e) {
      out.errors++;
      console.error("[razorpay-sweep] reconcile failed:", row.id, (e as Error).message);
    }
  }
  return out;
}
