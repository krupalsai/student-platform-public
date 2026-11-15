import { audit } from "@/lib/audit";
import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin, requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError, zodError, notFound, badRequest, dbError } from "@/lib/api-response";
import { getAllCollegeIds } from "@/lib/services/colleges";
import { normalizeToLocalPhone } from "@/lib/whatsapp/phone";
import { canAdminAccessBatch } from "@/lib/authz";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const EditSchema = z.object({
  full_name: z.string().min(1).max(100).optional(),
  // A bare min(10)/max(15) accepted anything 10–15 chars long — not
  // necessarily a mobile number. Normalize (91/0 prefixes) and require a
  // real 10-digit Indian mobile, the same rule as registration and profile
  // correction, so no write path can store a number the fee-page prefill
  // can't use.
  phone: z.string().trim().optional()
    .transform(v => v === undefined ? undefined : normalizeToLocalPhone(v))
    .refine(v => v === undefined || /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit mobile number"),
  // Validated against the live colleges table below, not a hardcoded enum —
  // a fixed ["GNIT","GNITC"] list here would silently block an admin from
  // ever correcting a student onto any college added later. Same trap as
  // items #101/#107/#114/#118.
  college: z.string().min(1).max(100).optional(),
  // Accept an empty string (from a cleared/unfilled input) as "no change"
  // rather than failing validation — previously Number("") became 0, which
  // failed min(1) and silently blocked the entire save with no clear reason.
  year: z.union([z.number().int().min(1).max(5), z.literal(0), z.nan()]).optional()
    .transform(v => (v === 0 || (typeof v === "number" && Number.isNaN(v))) ? undefined : v),
  // Same "empty means no change" treatment as year, for the same reason:
  // a spot-added student (item #150) can genuinely have branch/roll_number/
  // home_address as null, and the edit form's Save always sends all three
  // fields regardless of whether they're blank — a bare `.min(1)` here
  // failed EVERY save for that student, even one only touching an unrelated
  // field like name/phone.
  // MUST be `.nullable()` too, not just `.optional()`: the client's state
  // for an untouched blank field is the literal `null` it got back from
  // GET (the <input> only shows "" via `?? ""`, it never writes that back
  // into state) — `z.string().optional()` alone rejects `null` outright
  // (a type error, not the empty-string case below), which is exactly why
  // the first fix (item #163, empty-string-only) still 400'd on the very
  // next student who never touched these fields at all.
  branch: z.string().max(50).nullable().optional().transform(v => (v === "" || v === null) ? undefined : v),
  roll_number: z.string().max(20).nullable().optional().transform(v => (v === "" || v === null) ? undefined : v),
  home_address: z.string().max(500).nullable().optional().transform(v => (v === "" || v === null) ? undefined : v),
  batch_id: z.string().uuid().nullable().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();
  const { id } = await ctx.params;
  if (!id) return badRequest("Missing student ID");
  const db = createServiceClient();
  const { data } = await db.from("profiles")
    .select("id,full_name,father_name,college_id_path,username,phone,college,roll_number,branch,year,role,is_profile_complete,created_at,batch_id,batches!profiles_batch_id_fkey(name,slug,fee_amount,college)")
    .eq("id", id)
    .maybeSingle();
  if (!data) return notFound("Student");
  if (user!.role !== "super_admin") {
    if (!data.batch_id || !(await canAdminAccessBatch(db, user!.profileId, user!.role, data.batch_id))) return forbidden();
  }
  return ok(data);
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const { id } = await ctx.params;
    if (!id) return badRequest("Missing student ID");
    const body = EditSchema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const db = createServiceClient();

    // Batch isolation (same gate as GET): a normal admin may only edit
    // students in their assigned batches — the phone field is the login
    // identifier, so an unchecked edit is an account takeover.
    const { data: target } = await db.from("profiles")
      .select("batch_id")
      .eq("id", id)
      .maybeSingle();
    if (!target) return notFound("Student");
    if (user!.role !== "super_admin") {
      if (!target.batch_id || !(await canAdminAccessBatch(db, user!.profileId, user!.role, target.batch_id))) return forbidden();
    }

    // Existence check against ALL colleges, not just active ones: a student
    // belonging to an inactive college (e.g. BIET) must still be editable.
    if (body.data.college) {
      const validIds = await getAllCollegeIds(db);
      if (!validIds.includes(body.data.college)) return badRequest("Unknown college.");
    }

    // If college is being changed, and the student currently has a batch
    // assigned, verify that batch actually belongs to the NEW college —
    // otherwise clear batch_id so payments/certificates aren't routed to
    // the wrong college's batch. Admin can reassign the correct batch
    // afterward via the student's edit screen.
    const updateData: Record<string, any> = { ...body.data };
    let staleBatchId: string | null = null;
    if (body.data.college) {
      const { data: existing } = await db.from("profiles")
        .select("batch_id, batches!profiles_batch_id_fkey(college)")
        .eq("id", id)
        .maybeSingle();
      const currentBatchCollege = (existing?.batches as any)?.college;
      if (existing?.batch_id && currentBatchCollege && currentBatchCollege !== body.data.college) {
        updateData.batch_id = null;
        staleBatchId = existing.batch_id;
      }
    }

    const { data, error: err } = await db.from("profiles")
      .update(updateData)
      .eq("id", id)
      .select("id")
      .single();
    if (err) return dbError("api/admin/students/[id] PATCH", err);
    if (!data) return serverError("Update failed");

    // The profile's batch link was just cleared above because it no longer
    // matches the student's new college. Any payment row still pointing at
    // that same stale batch would otherwise keep routing this student's
    // paid/approved record under the old college's roster and DOCX export —
    // clear it there too so profile and payment can never disagree on which
    // batch applies. (Scoped to this student + this exact stale batch only.)
    let paymentBatchCleared = false;
    if (staleBatchId) {
      const { data: clearedPayments } = await db.from("payments")
        .update({ batch_id: null })
        .eq("student_id", id)
        .eq("batch_id", staleBatchId)
        .select("id");
      paymentBatchCleared = (clearedPayments?.length ?? 0) > 0;
    }

    await audit("student.college_or_details_edited", "profile", id, {
      changed_fields: Object.keys(body.data),
      college_changed: !!body.data.college,
      batch_cleared: updateData.batch_id === null,
      payment_batch_cleared: paymentBatchCleared,
    }, user!.profileId, "admin");

    return ok({ updated: true, batch_cleared: updateData.batch_id === null });
  } catch (err) { console.error("[api/admin/students/[id]]", err); return serverError(); }
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  // Deletion is super_admin-only — a restricted admin can monitor (GET) and
  // edit (PATCH) students but must not be able to delete anything. See
  // session.ts's requireSuperAdmin comment.
  const { user, error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  const { id } = await ctx.params;
  if (!id) return badRequest("Missing student ID");

  let reason = "";
  try {
    const body = await req.json();
    reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  } catch (err) { console.error("[api/admin/students/[id]]", err);
    // no JSON body sent
  }
  if (!reason) return badRequest("A reason is required to delete a student.");

  const db = createServiceClient();

  const { data: target } = await db.from("profiles")
    .select("id, role, full_name, roll_number, branch, college, batches!profiles_batch_id_fkey(name)")
    .eq("id", id)
    .maybeSingle();

  if (!target) return notFound("Student");

  if (["admin", "super_admin"].includes(target.role)) {
    return badRequest("Admin accounts cannot be deleted. Demote the user first.");
  }

  if (target.id === user!.profileId) {
    return badRequest("You cannot delete your own account.");
  }

  // Archive a snapshot before the profile row is gone for good. This is what
  // lets the student still see who/why they were removed the next time they
  // open the app, even though their profile no longer exists.
  await db.from("removed_students").insert({
    full_name: target.full_name,
    roll_number: target.roll_number,
    branch: target.branch,
    college: target.college,
    batch_name: (target.batches as any)?.name ?? null,
    reason,
    removed_by: user!.profileId,
  });

  await db.from("payments").delete().eq("student_id", id);
  await db.from("petitions").delete().eq("student_id", id);
  await db.from("sessions").delete().eq("student_id", id);
  await db.from("documents").delete().eq("student_id", id);
  await db.from("student_queries").delete().eq("student_id", id);
  await db.from("student_events").delete().eq("student_id", id);
  await db.from("student_notifications").delete().eq("student_id", id);
  await db.from("registration_tokens").delete().eq("profile_id", id);
  await db.from("action_rate_limits").delete().eq("actor_id", id);
  const { error: err } = await db.from("profiles").delete().eq("id", id);
  if (err) return dbError("api/admin/students/[id] DELETE", err);

  await audit("student.deleted", "profile", id, { deleted_by: user!.profileId, reason }, user!.profileId, user!.role);
  return ok({ deleted: true });
}
