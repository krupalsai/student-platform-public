/**
 * Batch resolution for the registration page's "college known, no batch"
 * fallthrough (src/app/register/page.tsx loadBatch).
 *
 * The page can know a student's college without knowing their batch: GET
 * /api/profile surfaces an unconsumed registration token's college for an
 * incomplete profile (see getStudentProfileRaw), but not the token's batch.
 * Before concluding "no active batch" and waitlisting the student, the
 * page must look the college's active batch up (same endpoint the college
 * picker uses) — a student whose batch is open must be able to register.
 *
 * Live incident 11 Nov 2026: a GNITC student holding a token for GNITC
 * Batch 2 (active, seats available) was told registrations were paused,
 * because the page never looked the batch up and the waitlist join then
 * 409'd (the profile row has no college) while the page claimed they'd
 * been waitlisted. No queue row was ever created.
 */

export interface ActiveBatchLike {
  slug: string;
  college: string;
  fee_amount: number;
  status: string;
}

/**
 * First active batch for this college, or null. The /api/batches endpoint
 * already filters by college + active, so this is a defensive check that
 * the row really is this college's active batch — never another college's.
 */
export function firstActiveBatchForCollege(
  batches: ActiveBatchLike[] | null | undefined,
  college: string,
): ActiveBatchLike | null {
  if (!college || !Array.isArray(batches)) return null;
  return batches.find((b) => b && b.college === college && b.status === "active") ?? null;
}
