import type { SupabaseClient } from "@supabase/supabase-js";
import { PETITION_MIN_SEATS } from "@/lib/config";

/**
 * Central payment gate used by every payment route and by the student status UI.
 *
 * Payment is available as soon as the student's batch is active and has a
 * positive fee, unless an admin explicitly closes payments. The batch minimum
 * is informational only and must never block payment.
 */

export type PaymentGateReason =
  | "open"
  | "no_batch"
  | "batch_inactive"
  | "below_minimum"
  | "closed_by_admin"
  | "fee_not_set";

/**
 * Whether the batch minimum is worth telling a student. A minimum of 1 (or an
 * unset/zero one) says nothing — "the petition needs at least 1" reads as a
 * mistake — so the sentence is left out. The minimum itself is untouched: it is
 * still stored, still shown to admins, and never a payment gate.
 */
export function isPetitionMinimumWorthStating(required: number | null | undefined): boolean {
  return Number(required) > 1;
}

export interface PaymentGate {
  open: boolean;
  reason: PaymentGateReason;
  /** What the student is told. Written for them, not for a log. */
  message: string | null;
  registered: number;
  required: number;
  fee: number | null;
  batchId: string | null;
}

interface BatchRow {
  id: string;
  status: string | null;
  fee_amount: string | number | null;
  payment_open: boolean | null;
  min_seats: number | null;
}

/** Counts completed registrations — the same definition the seat card uses. */
async function countRegistered(db: SupabaseClient, batchId: string): Promise<number> {
  const { count } = await db
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("is_profile_complete", true);
  return count ?? 0;
}

export async function getPaymentGateForBatch(
  db: SupabaseClient,
  batchId: string | null | undefined,
): Promise<PaymentGate> {
  const base = { registered: 0, required: PETITION_MIN_SEATS, fee: null, batchId: batchId ?? null };

  if (!batchId) {
    return { ...base, open: false, reason: "no_batch",
      message: "You are not in a batch yet. Complete your registration first." };
  }

  const { data } = await db
    .from("batches")
    .select("id, status, fee_amount, payment_open, min_seats")
    .eq("id", batchId)
    .maybeSingle();
  const batch = data as BatchRow | null;

  if (!batch) {
    return { ...base, open: false, reason: "no_batch", message: "Batch not found." };
  }

  const required = batch.min_seats ?? PETITION_MIN_SEATS;
  const fee = batch.fee_amount == null ? null : Number(batch.fee_amount);
  const feeSet = fee != null && fee > 0;

  // Counted before the status check: a closed batch still has registered
  // students, and callers (the Support menu, the assistant's facts) show this
  // number — returning 0 for a closed batch told students nobody had joined.
  const registered = await countRegistered(db, batch.id);

  if (batch.status !== "active") {
    return { ...base, registered, required, fee, open: false, reason: "batch_inactive",
      message: "This batch is not currently accepting payments." };
  }

  // IMPORTANT: min_seats is not a payment gate. It may still be displayed as
  // batch capacity/petition information, but students can pay immediately.
  // payment_open remains an explicit admin veto.
  if (batch.payment_open === false) {
    return { ...base, registered, required, fee, open: false, reason: "closed_by_admin",
      message: "Payment is temporarily closed for your batch. You'll be notified when it reopens." };
  }

  if (!feeSet) {
    return { ...base, registered, required, fee: null, open: false, reason: "fee_not_set",
      message: "The fee for your batch has not been set yet. Please check back shortly." };
  }

  return { ...base, registered, required, fee, open: true, reason: "open", message: null };
}

/**
 * The gate for a given student, resolved through their own batch.
 * The batch is read from their profile, never from the request.
 */
export async function getPaymentGateForStudent(
  db: SupabaseClient,
  studentId: string,
): Promise<PaymentGate> {
  const { data: profile } = await db
    .from("profiles").select("batch_id").eq("id", studentId).maybeSingle();
  return getPaymentGateForBatch(db, profile?.batch_id ?? null);
}
