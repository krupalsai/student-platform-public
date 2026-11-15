import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/session";
import { uploadToCloudinary, deleteStoredAsset } from "@/lib/storage";
import { createServiceClient } from "@/lib/supabase/server";
import { ok, forbidden, serverError, badRequest, notFound, dbError } from "@/lib/api-response";
import { audit } from "@/lib/audit";
import { ALLOWED_IMAGE_MIME } from "@/lib/image-types";

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED  = ALLOWED_IMAGE_MIME as readonly string[];

// Which student document fields an admin is allowed to re-upload on a
// student's behalf, and which DB column each one writes to.
const FIELD_COLUMNS: Record<string, string> = {
  college_id:      "college_id_path",
  photo_signature: "photo_signature_path",
};

/**
 * POST /api/admin/students/[id]/upload
 *
 * Lets an admin upload a replacement document (College ID or
 * Photo+Signature) for a student who can't do it themselves right now —
 * e.g. the admin received the file over WhatsApp and needs to attach it
 * to that student's record directly, without the student going through
 * the registration form again.
 *
 * Body: multipart/form-data with fields:
 *   - file  (the image)
 *   - field ("college_id" | "photo_signature")
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id: studentId } = await params;

  try {
    const form  = await req.formData();
    const file  = form.get("file") as File | null;
    const field = form.get("field") as string | null;

    if (!file)                          return badRequest("No file provided");
    if (!field || !FIELD_COLUMNS[field]) return badRequest("Invalid or missing field");
    if (!ALLOWED.includes(file.type))   return badRequest("Only JPEG, PNG, WebP allowed");
    if (file.size > MAX_SIZE)           return badRequest("File too large — max 5 MB");

    const db = createServiceClient();
    const { data: student } = await db.from("profiles")
      .select("id, full_name, college_id_path, photo_signature_path")
      .eq("id", studentId)
      .eq("role", "student")
      .maybeSingle();
    if (!student) return notFound("Student not found");
    const oldPath = (student as any)[FIELD_COLUMNS[field]] as string | null;

    const buffer   = Buffer.from(await file.arrayBuffer());
    const filename = `${studentId}/${field}_admin_${Date.now()}`;

    const { storagePath, url } = await uploadToCloudinary(
      "docs", buffer, filename, file.type
    );

    const column = FIELD_COLUMNS[field];
    const { error: updateErr } = await db.from("profiles")
      .update({ [column]: storagePath })
      .eq("id", studentId);
    if (updateErr) return dbError("api/admin/students/[id]/upload", updateErr, "Could not save the document. Please try again.");

    if (oldPath && oldPath !== storagePath) {
      await deleteStoredAsset("docs", oldPath);
    }

    await audit("student.document_uploaded_by_admin", "profile", studentId, {
      field, storage_path: storagePath, student_name: student.full_name,
    }, user!.profileId, "admin");

    return ok({ storage_path: storagePath, url, field });
  } catch (e) {
    console.error("[api/admin/students/[id]/upload]", e);
    return serverError();
  }
}
