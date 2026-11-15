import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Clean, platform-agnostic petition status. No existing route reads the
 * petitions table yet (0 rows in production as of today) — this is the
 * first consumer, built directly against the real schema (student_id,
 * batch_id, status, statement, reviewed_by/at, review_notes).
 */
export interface PetitionStatus {
  hasPetition: boolean;
  status: string | null;
  statement: string | null;
  reviewNotes: string | null;
  filedAt: string | null;
  reviewedAt: string | null;
}

export async function getPetitionStatus(db: SupabaseClient, studentId: string): Promise<PetitionStatus> {
  const { data } = await db
    .from("petitions")
    .select("status, statement, review_notes, created_at, reviewed_at")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    return { hasPetition: false, status: null, statement: null, reviewNotes: null, filedAt: null, reviewedAt: null };
  }

  return {
    hasPetition: true,
    status: data.status,
    statement: data.statement,
    reviewNotes: data.review_notes,
    filedAt: data.created_at,
    reviewedAt: data.reviewed_at,
  };
}

/**
 * Creates the one petition record every registered student gets, the
 * moment they're assigned to a batch. status defaults to 'draft' at the
 * database level (not set here); payment_id and statement stay null until
 * later steps populate them.
 *
 * Idempotent: a unique index on petitions.student_id makes a duplicate
 * insert a no-op rather than an error, so calling this more than once for
 * the same student (a retry, or any future change to the call site) can
 * never create a second record.
 *
 * The record belongs to the batch the student is IN. `ignoreDuplicates` leaves
 * an existing row exactly as it was, which is right for its status and notes
 * but not for its batch: a student whose batch closed was moved to the next
 * one (services/batches.ts), and a payment approved afterwards can pull them
 * back (auto-approve.ts). So a row that points at another batch is re-pointed
 * here — only `batch_id`, never the status.
 */
export async function createPetitionForStudent(
  db: SupabaseClient,
  studentId: string,
  batchId: string
): Promise<void> {
  const { error } = await db
    .from("petitions")
    .upsert({ student_id: studentId, batch_id: batchId }, { onConflict: "student_id", ignoreDuplicates: true });
  if (error) { console.error("createPetitionForStudent failed:", error); return; }

  const { error: repointError } = await db
    .from("petitions")
    .update({ batch_id: batchId })
    .eq("student_id", studentId)
    .neq("batch_id", batchId);
  if (repointError) console.error("createPetitionForStudent: could not re-point the petition:", repointError);
}

const ID_CHUNK = 200;

/**
 * Moves the petition records of students who just changed batch, so a record
 * never keeps pointing at the batch they left.
 *
 * Who is told about a court order (court-order-watch.ts) and what the bot
 * answers to "petition status" (whatsapp/router.ts, which refuses when the
 * record's batch is not the student's current one) both read petitions.batch_id.
 * Without this, a student moved to the next batch would keep getting the old
 * batch's court news and be told their record "doesn't match" their batch.
 *
 * `fromBatchId` is part of the filter, so a record that already moved on (a
 * retry, or a payment that pulled the student back) is left alone. Chunked:
 * `.in()` becomes part of the request URL. Returns how many records moved.
 */
export async function movePetitionsToBatch(
  db: SupabaseClient,
  studentIds: string[],
  fromBatchId: string,
  toBatchId: string
): Promise<number> {
  let moved = 0;
  for (let i = 0; i < studentIds.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from("petitions")
      .update({ batch_id: toBatchId })
      .eq("batch_id", fromBatchId)
      .in("student_id", studentIds.slice(i, i + ID_CHUNK))
      .select("id");
    if (error) { console.error("movePetitionsToBatch failed:", error); continue; }
    moved += data?.length ?? 0;
  }
  return moved;
}
