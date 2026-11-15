import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError, zodError, notFound, dbError, badRequest } from "@/lib/api-response";
import { processWaitlistForCollege } from "@/lib/services/waitlist-processing";
import { getAllCollegeIds } from "@/lib/services/colleges";
import { rollOverClosedBatch, BATCH_CARRY_COLUMNS, ClosedBatchRow } from "@/lib/services/batches";
import { canAdminAccessBatch } from "@/lib/authz";

const Schema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  // Validated against the live colleges table below, not a hardcoded enum —
  // same trap as items #101/#107/#114/#118, this time blocking a batch from
  // ever being created/edited for a college added after this file was written.
  college: z.string().trim().min(1).max(100).optional(),
  fee_amount: z.number().positive().optional(),
  upi_id: z.string().trim().optional(),
  upi_name: z.string().trim().optional(),
  status: z.enum(["active","paused","closed","archived","full"]).optional(),
  description: z.string().max(500).optional(),
  batch_limit: z.number().int().positive().nullable().optional(),
  low_seat_alert_threshold: z.number().int().min(0).nullable().optional(),
  // Once a batch's petition is actually filed, the lawyer gives the case
  // type/number/year for the writ petition covering the WHOLE batch — a
  // different thing from the per-student `petitions` table (one row per
  // student's own filing status). Nullable so an admin can clear a wrong
  // entry, not just overwrite it.
  case_type: z.string().trim().max(20).nullable().optional(),
  case_number: z.string().trim().max(50).nullable().optional(),
  case_year: z.string().trim().max(10).nullable().optional(),
  case_status_url: z.string().trim().max(300).nullable().optional(),
  // The batch member who takes initiative once the lawyer's Court Order
  // parcel (item #172) arrives — arranges Xerox reference copies for the
  // batch. Admin-set, purely informational, nullable so a wrong entry can
  // be cleared.
  representative_name: z.string().trim().max(100).nullable().optional(),
  representative_phone: z.string().trim().max(20).nullable().optional(),
  // The batch's separate second payment (extra_fee_payments). Students see
  // it only once it is enabled AND their main fee is approved.
  extra_fee_amount: z.number().positive().max(100000).nullable().optional(),
  extra_fee_label: z.string().trim().max(60).nullable().optional(),
  extra_fee_note: z.string().trim().max(300).nullable().optional(),
  extra_fee_enabled: z.boolean().optional(),
  extra_fee_starts_at: z.string().datetime({ offset: true }).nullable().optional(),
});

// Single-batch lookup — currently only needed to show the batch name on the
// admin Discussion (group chat) screen, which is reached from a batch card
// carrying just the id.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  const db = createServiceClient();
  const { data, error: err } = await db
    .from("batches")
    .select("id, name, slug, college, status")
    .eq("id", id)
    .maybeSingle();

  if (err) return dbError("api/admin/batches/[id] GET", err);
  if (!data) return notFound("Batch");
  if (user!.role !== "super_admin" && !(await canAdminAccessBatch(db, user!.profileId, user!.role, id))) return forbidden();
  return ok(data);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  const accessDb = createServiceClient();
  if (user!.role !== "super_admin" && !(await canAdminAccessBatch(accessDb, user!.profileId, user!.role, id))) return forbidden();
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const db = createServiceClient();

    // Existence check against ALL colleges, not just active ones: a batch
    // belonging to an inactive college (e.g. BIET) must still be editable.
    if (body.data.college) {
      const validIds = await getAllCollegeIds(db);
      if (!validIds.includes(body.data.college)) return badRequest("Unknown college.");
    }

    const updateData: Record<string, any> = { ...body.data };
    // Capture the pre-update row so a transition to "closed" can trigger the
    // same unpaid-student transfer the End Batch flow performs — closing must
    // never strand students, no matter which UI path does it.
    const { data: before } = await db.from("batches")
      .select(`id, name, college, status, ${BATCH_CARRY_COLUMNS}`)
      .eq("id", id)
      .maybeSingle();
    // An empty string from the admin form means "clear this," not "set it to
    // the empty string" — matters for case_type/case_number/case_year/
    // case_status_url, the only fields here an admin removes rather than
    // just overwrites (e.g. a case number entered wrong, or a case that
    // hasn't been filed yet after all).
    for (const key of ["case_type", "case_number", "case_year", "case_status_url", "representative_name", "representative_phone", "extra_fee_label", "extra_fee_note"] as const) {
      if (updateData[key] === "") updateData[key] = null;
    }

    // Only one active batch per college: if this update is activating a
    // batch, demote any other currently-active batch in the same college
    // first. The unique index on batches(college) WHERE status='active'
    // is the backstop if this is ever bypassed.
    if (body.data.status === "active") {
      const { data: current } = await db.from("batches")
        .select("college").eq("id", id).maybeSingle();
      const college = body.data.college ?? current?.college;
      if (college) {
        await db.from("batches")
          .update({ status: "paused" })
          .eq("college", college)
          .eq("status", "active")
          .neq("id", id);
      }
    }

    // Changing the seat limit or the alert threshold means the previous
    // "already alerted" state no longer reflects reality — reset it so
    // a new low-seat alert can fire again if the new numbers warrant it.
    if (body.data.batch_limit !== undefined || body.data.low_seat_alert_threshold !== undefined) {
      updateData.low_seat_alert_sent_at = null;
    }

    // Regenerate upi_link if upi_id or fee_amount changed
    if (body.data.upi_id || body.data.fee_amount) {
      const { data: existing } = await db.from("batches")
        .select("upi_id, upi_name, fee_amount").eq("id", id).maybeSingle();
      if (existing) {
        const upi_id = body.data.upi_id ?? existing.upi_id;
        const upi_name = body.data.upi_name ?? existing.upi_name ?? "Fee Payment";
        const fee_amount = body.data.fee_amount ?? existing.fee_amount;
        if (upi_id) {
          updateData.upi_link = `upi://pay?pa=${encodeURIComponent(upi_id)}&pn=${encodeURIComponent(upi_name)}&am=${fee_amount}&cu=INR`;
        }
      }
    }

    const { data, error: err } = await db.from("batches")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (err || !data) return notFound("Batch");

    if (body.data.status === "active") {
      // AWAITED: unawaited work is killed when the lambda freezes after the
      // response — waitlisted students would never receive their link.
      await processWaitlistForCollege(db, data.college).catch(e =>
        console.error("[api/admin/batches/[id]] waitlist processing failed:", e)
      );
    }

    // Closing a batch (from any previous status) rolls it over exactly like
    // POST /end does — the college's next batch (created if there is none),
    // every UNPAID member moved into it, paid members left as the closed
    // batch's history, the waiting list told if a batch was just created. One
    // shared function (rollOverClosedBatch), so the edit form cannot strand
    // students and cannot disagree with the End button. Best-effort here: the
    // status change itself has already succeeded, and the repair button
    // (POST /repair-transfer) covers any gap.
    let transfer: { moved: number; to_batch: string | null; to_batch_name: string | null; failed?: boolean } | null = null;
    if (body.data.status === "closed" && before && before.status !== "closed") {
      try {
        const { target, moved } = await rollOverClosedBatch(
          db,
          { ...(before as Omit<ClosedBatchRow, "college">), college: data.college } as ClosedBatchRow,
          user!.profileId,
        );
        transfer = { moved, to_batch: target.id, to_batch_name: target.name };
      } catch (e) {
        console.error("[api/admin/batches/[id]] close-transfer failed:", e);
        transfer = { moved: 0, to_batch: null, to_batch_name: null, failed: true };
      }
    }

    return ok({ ...data, transfer });
  } catch (err) { console.error("[api/admin/batches/[id]]", err);
    return serverError();
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Deletion is super_admin-only — see students/[id]/route.ts's DELETE
  // for the same reasoning.
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  const db = createServiceClient();

  // Guard: prevent delete if completed-profile students are enrolled
  // (ghost/incomplete accounts are cleared automatically on delete)
  const { count: studentCount } = await db
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", id)
    .eq("is_profile_complete", true);

  if ((studentCount ?? 0) > 0) {
    return serverError(`Cannot delete: ${studentCount} student(s) are enrolled in this batch. Reassign or remove them first.`);
  }

  // Clear ghost (incomplete) enrollments from this batch before archiving
  await db.from("profiles")
    .update({ batch_id: null })
    .eq("batch_id", id)
    .eq("is_profile_complete", false);

  // Soft delete: set status to archived rather than hard delete
  const { error: err } = await db
    .from("batches")
    .update({ status: "archived" })
    .eq("id", id);

  if (err) return dbError("api/admin/batches/[id]", err);
  return ok({ archived: true });
}
