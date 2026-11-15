import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { deleteStoredAsset } from "@/lib/storage";
import { isDocumentStoragePath } from "@/lib/storage-paths";
import { ok, forbidden, serverError, badRequest, dbError } from "@/lib/api-response";

/**
 * POST /api/profile/reupload-id
 *
 * One-time self-service College ID re-upload. Body: { storage_path }
 * (the path returned by /api/uploads/college-id).
 *
 * This exists for students whose first College ID upload was missing
 * their signature and needs one correction chance — separate from the
 * full profile PATCH so it works regardless of registration/payment
 * state, and so it can be permanently locked after first use without
 * affecting any other profile field.
 *
 * Once college_id_reupload_used = true, this endpoint refuses further
 * changes — from that point on, only an admin can update the College ID
 * (via /api/admin/students/[id]/upload, unlocked in the Docs sheet).
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const body = await req.json().catch(() => null);
    const storagePath = body?.storage_path as string | undefined;
    if (!storagePath || typeof storagePath !== "string") {
      return badRequest("storage_path is required");
    }
    // Must be a reference /api/uploads/college-id issued, not an arbitrary
    // string — otherwise this endpoint will set a student's college ID to
    // another student's document.
    if (!isDocumentStoragePath(storagePath)) {
      return badRequest("Invalid document reference");
    }

    const db = createServiceClient();

    const { data: profile } = await db.from("profiles")
      .select("id, college_id_reupload_used, college_id_path")
      .eq("id", user!.profileId)
      .maybeSingle();

    if (!profile) return badRequest("Profile not found");

    if (profile.college_id_reupload_used) {
      return badRequest("You've already used your one-time College ID re-upload. Contact admin if you need a further change.");
    }

    const { error: updateErr } = await db.from("profiles")
      .update({
        college_id_path: storagePath,
        college_id_reupload_used: true,
        college_id_reupload_used_at: new Date().toISOString(),
      })
      .eq("id", user!.profileId);

    if (updateErr) return dbError("api/profile/reupload-id", updateErr, "Could not save your College ID. Please try again.");

    // Old file is no longer referenced anywhere — remove it so it doesn't
    // linger as an orphaned asset in storage.
    if (profile.college_id_path && profile.college_id_path !== storagePath) {
      await deleteStoredAsset("docs", profile.college_id_path);
    }

    await audit("student.college_id_reuploaded", "profile", user!.profileId, {
      previous_path: profile.college_id_path,
      new_path: storagePath,
    }, user!.profileId, "student");

    return ok({ updated: true });
  } catch (e) {
    console.error("[api/profile/reupload-id]", e);
    return serverError();
  }
}
