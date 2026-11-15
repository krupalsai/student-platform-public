/**
 * The one plain line the batches overview shows under each batch: who has
 * paid and — for a batch that is closed — whether anyone is stranded in it.
 *
 * A closed batch is a finished cohort: the people left in it should be exactly
 * the ones who paid (their court case, exhibit and notices live with the
 * batch). Anyone still there who has NOT paid cannot pay any more, so that is
 * the one case worth shouting about (red); "all paid, nobody waiting" is the
 * calm answer to "did everyone roll over?".
 *
 * Returns null when the API could not read payments — a missing line is honest,
 * "nobody waiting" built on a failed read is not.
 */
export interface PaidLineBatch {
  status: string;
  /** Finished registrations in the batch (the same number the card prints as "N students"). */
  student_count: number;
  /** Finished registrations with an approved payment. */
  paid_count: number | null;
  /** Everyone in the batch without an approved payment, finished or not. */
  not_paid_count: number | null;
}

export function paidLine(b: PaidLineBatch): { text: string; color: string } | null {
  if (b.paid_count == null || b.not_paid_count == null) return null;
  if (b.status === "active") {
    // Counted against the same "N students" the card prints just above, so the
    // two lines always add up. (not_paid_count also holds unfinished
    // registrations, which that figure leaves out — right for deciding who is
    // stranded in a closed batch, confusing next to a live batch's headcount.)
    const notPaid = Math.max(0, b.student_count - b.paid_count);
    return { text: `${b.paid_count} paid · ${notPaid} not paid`, color: "#6b7280" };
  }
  if (b.not_paid_count === 0) {
    return { text: b.paid_count > 0 ? "All paid — nobody waiting" : "Empty — nobody waiting", color: "#166534" };
  }
  return { text: `${b.not_paid_count} not paid — still in this closed batch`, color: "#b91c1c" };
}
