import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Count completed profiles enrolled in a college's batches.
 *
 * Counts by the BATCH's college, not the profile's own `college` column:
 * a profile's college can disagree with its batch's college (a student's
 * profile says GNIT while they are enrolled in GNITC Batch 2), and the
 * batch views count by the batch — so the Colleges page must do the same
 * or the two views disagree (Colleges said GNIT 50, batch views sum to 49).
 *
 * Only non-archived batches count, and only completed profiles that are
 * actually enrolled in one of them (a profile with no batch, or in an
 * archived batch, is not counted for any college).
 */
export async function countStudentsInCollegeBatches(
  db: SupabaseClient,
  collegeId: string,
): Promise<number> {
  const { data: batchRows } = await db
    .from("batches")
    .select("id")
    .neq("status", "archived")
    .eq("college", collegeId);
  const batchIds = (batchRows ?? []).map((b) => String((b as { id: unknown }).id));
  if (batchIds.length === 0) return 0;
  const { count } = await db
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .eq("is_profile_complete", true)
    .in("batch_id", batchIds);
  return count ?? 0;
}
