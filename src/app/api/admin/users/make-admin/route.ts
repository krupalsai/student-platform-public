import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError, zodError, dbError, badRequest, notFound } from "@/lib/api-response";
import { upsertAdmin, deactivateAdmin, WA_ROLE_FOR_WEBSITE_ROLE } from "@/lib/whatsapp/admin-service";

// "Make as Admin" from the admin Students roster (per-student button).
//
// Rule (Krupal, 2026-10-21): a batch may have AT MOST 2 normal admins.
// The count is enforced here, server-side — the button hiding in the UI is
// only cosmetic. An "admin of a batch" is counted two ways and unioned, so
// neither source can be used to sneak past the cap:
//   1. profiles with role = 'admin' whose own batch_id is this batch
//      (how every existing admin was created before assignments existed), and
//   2. admin_batch_assignments rows for this batch.
// super_admin never counts toward the 2 — the super admin runs the platform,
// they are not one of a batch's two admins.
//
// Making an admin also records the assignment row and the WhatsApp `admins`
// row (via upsertAdmin) so phone/OTP admin login actually works — the same
// two-write pattern as /api/admin/users/add-admin.
const MAX_ADMINS_PER_BATCH = 2;

const Schema = z.object({
  student_id: z.string().min(1),
  action: z.enum(["make", "remove"]).default("make"),
});

export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireSuperAdmin(req);
    if (error) return forbidden();

    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const { student_id, action } = body.data;

    const db = createServiceClient();

    const { data: profile, error: findErr } = await db.from("profiles")
      .select("id, full_name, phone, role, batch_id")
      .eq("id", student_id)
      .maybeSingle();
    if (findErr) return dbError("make-admin profile lookup", findErr, "Profile lookup failed. Please try again.");
    if (!profile) return notFound("Student");
    if (profile.role === "super_admin") return badRequest("The super admin's role can't be changed here.");

    const name = profile.full_name ?? "This student";

    let batchName = "their batch";
    if (profile.batch_id) {
      const { data: batch } = await db.from("batches")
        .select("name").eq("id", profile.batch_id).maybeSingle();
      if (batch?.name) batchName = batch.name;
    }

    if (action === "remove") {
      if (profile.role !== "admin") return badRequest(`${name} is not an admin.`);
      const { error: upErr } = await db.from("profiles").update({ role: "student" }).eq("id", profile.id);
      if (upErr) return dbError("make-admin demote", upErr, "Failed to remove admin. Please try again.");
      await db.from("admin_batch_assignments").delete().eq("admin_id", profile.id);
      if (profile.phone) await deactivateAdmin(db, profile.phone);
      return ok({ status: "applied", message: `${name} is no longer an admin of ${batchName}.` });
    }

    // action === "make"
    if (!profile.batch_id) {
      return badRequest(`${name} has no batch assigned — assign a batch first, then make them its admin.`);
    }

    if (profile.role === "admin") {
      // Already an admin — just make sure the assignment + WhatsApp rows
      // exist (older admins predate the assignments table), then report.
      await db.from("admin_batch_assignments")
        .upsert({ admin_id: profile.id, batch_id: profile.batch_id, granted_by: user!.profileId }, { onConflict: "admin_id,batch_id", ignoreDuplicates: true });
      if (profile.phone) await upsertAdmin(db, profile.phone, WA_ROLE_FOR_WEBSITE_ROLE.admin, user!.profileId);
      return ok({ status: "already", message: `${name} is already an admin of ${batchName}.` });
    }

    // Count this batch's current admins (union of both sources, self excluded).
    const adminIds = new Set<string>();
    const { data: byProfile, error: cntErr } = await db.from("profiles")
      .select("id, full_name").eq("batch_id", profile.batch_id).eq("role", "admin");
    if (cntErr) return dbError("make-admin count profiles", cntErr, "Could not check this batch's admins. Please try again.");
    for (const r of byProfile ?? []) if (r.id !== profile.id) adminIds.add(r.id);
    const { data: byAssign } = await db.from("admin_batch_assignments")
      .select("admin_id").eq("batch_id", profile.batch_id);
    for (const r of byAssign ?? []) if (r.admin_id !== profile.id) adminIds.add(r.admin_id);

    if (adminIds.size >= MAX_ADMINS_PER_BATCH) {
      const names = (byProfile ?? []).map(r => r.full_name).filter(Boolean).join(", ");
      return badRequest(
        `${batchName} already has ${MAX_ADMINS_PER_BATCH} admins${names ? ` (${names})` : ""} — max ${MAX_ADMINS_PER_BATCH} per batch. Remove one first.`,
      );
    }

    const { error: upErr } = await db.from("profiles").update({ role: "admin" }).eq("id", profile.id);
    if (upErr) return dbError("make-admin promote", upErr, "Failed to make admin. Please try again.");

    await db.from("admin_batch_assignments")
      .upsert({ admin_id: profile.id, batch_id: profile.batch_id, granted_by: user!.profileId }, { onConflict: "admin_id,batch_id", ignoreDuplicates: true });

    // Required for phone/OTP admin login to actually work — see add-admin.
    if (profile.phone) await upsertAdmin(db, profile.phone, WA_ROLE_FOR_WEBSITE_ROLE.admin, user!.profileId);

    return ok({
      status: "applied",
      message: `${name} is now an admin of ${batchName} (${adminIds.size + 1} of ${MAX_ADMINS_PER_BATCH}).`,
    });
  } catch (e) {
    console.error("[make-admin] unhandled exception:", e);
    return serverError();
  }
}
