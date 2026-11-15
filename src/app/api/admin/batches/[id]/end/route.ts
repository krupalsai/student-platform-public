import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, badRequest, notFound, serverError } from "@/lib/api-response";
import { endBatchAndCreateNext, describeEndBatchFailure } from "@/lib/services/batches";
import { canAdminAccessBatch } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/batches/[id]/end
 *
 * Ends the college's current Active batch: closes it, creates the next
 * sequential batch as its single Active batch (Issue #1/#41), and moves
 * every UNPAID member over automatically. Paid members stay in the closed
 * batch as its history.
 *
 * Fee / payment configuration carries over to the new batch (same
 * carry-over the lazy registration path uses), so transferred students can
 * pay immediately. This is the ONLY way a new batch is created after the
 * first — registrations otherwise always join the one Active batch, no
 * matter how many students it holds.
 *
 * Idempotent and safe to double-tap: only one request wins the close, the
 * next-batch insert is guarded by the one-live-batch-per-college index, and
 * re-ending an already-ended batch finishes any stranded transfer instead of
 * erroring. A college's waiting list is told when this creates the batch.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  if (!id) return badRequest("Missing batch id");

  try {
    const db = createServiceClient();
    // Batch isolation: only a super_admin or an admin assigned to this
    // batch may end it — ending closes the batch, creates the next one,
    // and moves every unpaid member.
    if (user!.role !== "super_admin" && !(await canAdminAccessBatch(db, user!.profileId, user!.role, id))) return forbidden();
    const result = await endBatchAndCreateNext(db, id, user!.profileId);

    if (!result.ok) {
      const { message } = describeEndBatchFailure(result.reason);
      if (result.reason === "not_found") return notFound("Batch");
      if (result.reason === "not_active") return badRequest(message);
      // The batch is already closed by now (describeEndBatchFailure.batchClosed),
      // so this says what is true and how to finish rather than "nothing changed".
      return serverError(message);
    }

    return ok({
      ended: result.endedName,
      new_batch: result.newBatch,
      moved_students: result.movedStudents,
      repaired: result.repaired ?? false,
    });
  } catch (err) {
    console.error("[api/admin/batches/[id]/end]", err);
    return serverError();
  }
}
