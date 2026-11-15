import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, badRequest, notFound, serverError } from "@/lib/api-response";
import { rollOverClosedBatch, BATCH_CARRY_COLUMNS, ClosedBatchRow, RollOverError } from "@/lib/services/batches";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/batches/[id]/repair-transfer
 *
 * One-time repair (and future safety net): moves any UNPAID students still
 * sitting in a closed batch into the college's current live batch, creating
 * the next sequential batch when none exists yet. Paid students stay — they
 * are the closed batch's history.
 *
 * Use after closing batches that were ended before the automatic transfer
 * existed. Idempotent: re-running moves nothing new.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  if (!id) return badRequest("Missing batch id");

  try {
    const db = createServiceClient();

    const { data: batch } = await db.from("batches")
      .select(`id, name, college, status, ${BATCH_CARRY_COLUMNS}`)
      .eq("id", id)
      .maybeSingle();
    if (!batch) return notFound("Batch");
    if (batch.status !== "closed") {
      return badRequest("Only a closed batch can be repaired.");
    }

    let rolled;
    try {
      rolled = await rollOverClosedBatch(db, batch as ClosedBatchRow, user!.profileId, { repaired: true });
    } catch (e) {
      console.error("[api/admin/batches/[id]/repair-transfer] roll-over failed:", e);
      return serverError(
        e instanceof RollOverError && e.phase === "transfer"
          ? "Some students could not be moved. Nothing was lost — tap the button again to move the rest."
          : "The next batch could not be created. Nothing was changed — please try again.",
      );
    }

    return ok({
      batch: batch.name,
      to_batch: rolled.target.name,
      moved_students: rolled.moved,
    });
  } catch (err) {
    console.error("[api/admin/batches/[id]/repair-transfer]", err);
    return serverError();
  }
}
