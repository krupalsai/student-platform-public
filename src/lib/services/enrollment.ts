/**
 * The ONE definition of "a registered student in a batch".
 *
 * ── Why enrolment is NOT `role = 'student'` ────────────────────────────────
 * `profiles.role` is a single column, so promoting someone to admin overwrites
 * `student`. A person can genuinely be both: an admin who is also enrolled in a
 * batch and pays their own fee. That is live today, and
 * every query that measured enrolment with `role = 'student'` silently erased
 * those people from their own batch — the roster, the paid/not-paid tiles, the
 * seat/petition progress students are shown, the seat-limit maths that decides
 * whether a batch is full, and worst of all the DOCX court exhibit, which would
 * have filed a petition omitting a petitioner who had actually paid.
 *
 * Enrolment is a FACT about the profile, not a permission level:
 *
 *     ENROLLED  ==  assigned to the batch  AND  finished registering
 *     .eq("batch_id", batchId).eq("is_profile_complete", true)
 *
 * `is_profile_complete` is not optional — item #55 established that a
 * `batch_id` on its own just means someone opened the link and abandoned the
 * form, and those must never be counted.
 *
 * ── Rules ──────────────────────────────────────────────────────────────────
 * • Counting or listing who is IN a batch  → filter on enrolment, never role.
 *   Do not "restore" `.eq("role","student")` to one of those queries.
 * • Asking whether an ACCOUNT is staff     → keep filtering on role. Those are
 *   permission checks (e.g. the guards stopping an admin from editing or
 *   deleting another admin via the roster or the Copilot) and are correct.
 *
 * Kept as plain `.eq()` chains at each call site rather than a query-builder
 * wrapper on purpose: wrapping Supabase's builder in a generic blows up its
 * type inference (TS2589 "type instantiation is excessively deep"), and losing
 * the inferred row type is a worse trade than repeating two filters.
 * `isEnrolledProfile` below covers the JS-side checks.
 */

/** JS-side counterpart of the query filter above, for rows already fetched. */
export function isEnrolledProfile(
  p: { batch_id?: string | null; is_profile_complete?: boolean | null } | null | undefined,
  batchId?: string,
): boolean {
  if (!p?.is_profile_complete || !p.batch_id) return false;
  return batchId ? p.batch_id === batchId : true;
}

/**
 * Whether an account holds a staff permission level. Deliberately separate
 * from enrolment: a person can be both, and each question has its own answer.
 */
export function isStaffRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "super_admin" || role === "viewer";
}
