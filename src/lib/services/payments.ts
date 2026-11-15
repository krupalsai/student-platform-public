import { SupabaseClient } from "@supabase/supabase-js";

export interface RawLatestPayment {
  id: string;
  status: string;
  utr_number: string | null;
  amount: number | null;
  created_at: string;
  review_notes: string | null;
  // The payments table has no single gateway column: the gateway is
  // recorded as payment_method ("razorpay" | "cashfree" | "phonepe" |
  // "spot") plus one order/payment id per gateway. All of these are
  // needed to derive the gateway display label in getPaymentStatus.
  payment_method: string | null;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  cashfree_order_id: string | null;
  cashfree_payment_id: string | null;
  phonepe_merchant_txn_id: string | null;
  phonepe_txn_id: string | null;
}

/**
 * Priority order for resolving "the" status out of a student's multiple
 * payment rows. `approved` always outranks everything else regardless of
 * which row is more recent — an approved payment must never be shadowed by
 * a later stray/duplicate order (e.g. a retry the student tapped right
 * after paying, before the approval had landed. A real student's approved
 * ₹2,200 Cashfree payment was shown as "Payment In Progress... expired"
 * because a second pg_pending order got created 10
 * seconds after the approval, and multiple routes here were picking
 * whichever row was simply most recent by created_at). Within a priority
 * tier, ties fall to whichever row is encountered first — pass rows
 * pre-sorted `created_at desc` for "most recent among equal-priority rows".
 */
export const PAYMENT_STATUS_PRIORITY: Record<string, number> = {
  approved: 3,
  submitted: 2,
  reupload_requested: 2,
  rejected: 1,
  pg_failed: 1,
  pg_pending: 0,
  pending: 0,
};

/** Reduces a list of payment-like rows to one "best" row per student — see PAYMENT_STATUS_PRIORITY. */
export function bestPaymentPerStudent<T extends { student_id: string; status: string }>(
  rows: T[]
): Record<string, T> {
  const best: Record<string, T> = {};
  for (const row of rows) {
    const cur = best[row.student_id];
    const curPriority = cur ? (PAYMENT_STATUS_PRIORITY[cur.status] ?? -1) : -1;
    const newPriority = PAYMENT_STATUS_PRIORITY[row.status] ?? -1;
    if (newPriority > curPriority) best[row.student_id] = row;
  }
  return best;
}

/**
 * The student's effective payment status, in its raw internal shape —
 * what GET /api/payments/status returns to the dashboard (which switches
 * on the raw status strings — approved, pg_pending, rejected, etc. —
 * directly for its own styling/copy). An `approved` row always wins over
 * any other row regardless of recency (see PAYMENT_STATUS_PRIORITY);
 * otherwise falls back to the most recent attempt. Kept as its own
 * function so callers get this without their response shape changing.
 */
export async function getLatestPaymentRaw(
  db: SupabaseClient,
  studentId: string
): Promise<RawLatestPayment | null> {
  const { data } = await db
    .from("payments")
    .select("id, status, utr_number, amount, created_at, review_notes, payment_method, razorpay_order_id, razorpay_payment_id, cashfree_order_id, cashfree_payment_id, phonepe_merchant_txn_id, phonepe_txn_id")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false });
  if (!data || data.length === 0) return null;
  return data.find((p) => p.status === "approved") ?? data[0];
}

/**
 * Whether this student has a verified (admin-approved) payment.
 *
 * The one server-side question that gates route-map access. Looks for an
 * `approved` row directly rather than reading the *latest* payment's status:
 * a student who paid, was approved, and later has a second row created (a
 * correction, a re-upload request) is still a paid student.
 */
export async function hasApprovedPayment(db: SupabaseClient, studentId: string): Promise<boolean> {
  const { data } = await db
    .from("payments")
    .select("id")
    .eq("student_id", studentId)
    .eq("status", "approved")
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Clean, platform-agnostic payment status. Telegram, WhatsApp, and the
 * website all get the same shape back and each decide how to present it —
 * this returns data only, no display/formatting logic. Built on the same
 * raw lookup the dashboard uses, so the two are never inconsistent.
 */
export interface PaymentStatus {
  status: "paid" | "pending" | "failed" | "none";
  amount: number | null;
  paidAt: string | null;
  transactionId: string | null;
  reviewNotes: string | null;
  /**
   * How the payment was made, as a display label: "Razorpay" |
   * "Cashfree" | "PhonePe" | "in person" (a spot payment taken outside
   * any gateway) | null when unknown or when there is no payment.
   * Derived from payment_method, falling back to whichever gateway's
   * order/payment id is set on the row.
   */
  gateway: string | null;
}

const STATUS_MAP: Record<string, PaymentStatus["status"]> = {
  approved: "paid",
  pending: "pending",
  submitted: "pending",
  pg_pending: "pending",
  reupload_requested: "pending",
  rejected: "failed",
  pg_failed: "failed",
};

/** Derives the gateway display label from one raw payment row. */
export function derivePaymentGateway(raw: RawLatestPayment): string | null {
  const method = (raw.payment_method ?? "").trim().toLowerCase();
  if (method === "razorpay" || raw.razorpay_order_id || raw.razorpay_payment_id) return "Razorpay";
  if (method === "cashfree" || raw.cashfree_order_id || raw.cashfree_payment_id) return "Cashfree";
  if (method === "phonepe" || raw.phonepe_merchant_txn_id || raw.phonepe_txn_id) return "PhonePe";
  if (method === "spot") return "in person";
  return null;
}

export async function getPaymentStatus(db: SupabaseClient, studentId: string): Promise<PaymentStatus> {
  const raw = await getLatestPaymentRaw(db, studentId);
  if (!raw) return { status: "none", amount: null, paidAt: null, transactionId: null, reviewNotes: null, gateway: null };

  return {
    status: STATUS_MAP[raw.status] ?? "pending",
    amount: raw.amount,
    paidAt: raw.status === "approved" ? raw.created_at : null,
    transactionId: raw.utr_number,
    reviewNotes: raw.review_notes,
    gateway: derivePaymentGateway(raw),
  };
}
