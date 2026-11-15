/**
 * Summarize one batch's enrolment + payment numbers from already-fetched rows.
 *
 * Pure function — no database, no network — so the counting rules are
 * unit-testable without a Supabase client.
 *
 * The denominator is ALL completed profiles enrolled in the batch, whatever
 * their current role is. A person can subsequently be promoted to admin
 * without losing their enrolment or their already-approved payment, so the
 * student card and the payment statistics must share that one denominator.
 * Counting only role === "student" dropped batch admins from the card (GNIT
 * Batch 2 showed 23 while the list showed 25) while their payments still
 * counted — a mixed denominator.
 *
 * `bestPayments` is the per-student best payment row (see
 * bestPaymentPerStudent in payments.ts): one row per student, already
 * resolved so an approved payment is never shadowed by a later stray order.
 * The failed-payment split stays its own bucket: not_paid_students =
 * total - paid - failed. That is a deliberate definition difference from
 * the batch list's not-paid count, not a gap to close here.
 */

export interface BatchEnrolledProfile {
  id: string;
}

export interface BatchBestPayment {
  status: string;
  amount?: number | null;
}

export interface BatchStats {
  total_students: number;
  paid_students: number;
  not_paid_students: number;
  failed_payments: number;
  total_collected: number;
}

export function computeBatchStats(
  enrolledProfiles: BatchEnrolledProfile[],
  bestPayments: Record<string, BatchBestPayment>,
): BatchStats {
  const enrolledIds = enrolledProfiles.map((p) => p.id);
  let paidCount = 0;
  let totalCollected = 0;
  let failedCount = 0;

  for (const studentId of enrolledIds) {
    const row = bestPayments[studentId];
    if (!row) continue;
    if (row.status === "approved") {
      paidCount += 1;
      totalCollected += Number(row.amount ?? 0);
    } else if (row.status === "pg_failed") {
      failedCount += 1;
    }
  }

  const totalStudents = enrolledIds.length;
  return {
    total_students: totalStudents,
    paid_students: paidCount,
    not_paid_students: Math.max(0, totalStudents - paidCount - failedCount),
    failed_payments: failedCount,
    total_collected: totalCollected,
  };
}
