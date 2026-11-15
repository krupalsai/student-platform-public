import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, created, forbidden, badRequest, serverError, dbError } from "@/lib/api-response";
import { uploadToCloudinary } from "@/lib/storage";
import { ALLOWED_IMAGE_MIME } from "@/lib/image-types";
import { getCollegeIds } from "@/lib/services/colleges";

/**
 * Route Map attachments — admin upload.
 *
 * A single multipart POST rather than the announcements pattern (upload to
 * one route, then POST JSON to another): there is nothing to fill in between
 * the two steps here, and one request means a half-finished upload can't leave
 * an orphaned Cloudinary asset with no row pointing at it.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = [
  // Images via the shared list so an iPhone's HEIC is accepted here too
  // (see lib/image-types.ts) — an admin attaching a photo from their phone
  // hits exactly the same rejection students did.
  ...ALLOWED_IMAGE_MIME,
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
];

export async function GET(req: NextRequest) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  const db = createServiceClient();
  const { data, error: err } = await db
    .from("route_map_attachments")
    .select("id, college, title, description, file_url, file_name, file_type, kind, step_id, sort_order, created_at")
    .order("college", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (err) return dbError("api/admin/route-map", err);
  return ok(data ?? []);
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const title = String(form.get("title") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const college = String(form.get("college") ?? "").trim();
    const stepRaw = String(form.get("step_id") ?? "").trim();

    const db = createServiceClient();

    if (!file) return badRequest("Choose a photo or file to upload.");
    if (!title) return badRequest("Give this attachment a title.");
    // "all" is a real sentinel meaning every college, not a college id —
    // check it before the DB lookup. Otherwise validated against the live
    // colleges table, not a hardcoded list (same trap as items #101/#107/
    // #114/#118 — this one blocked ever uploading a Route Map for a college
    // added after this route was written).
    if (college !== "all") {
      const validIds = await getCollegeIds(db);
      if (!validIds.includes(college)) return badRequest("Pick which college this is for.");
    }
    if (!ALLOWED_MIME.includes(file.type)) return badRequest("Only JPG, PNG, WEBP, PDF or DOCX files are allowed.");
    if (file.size > MAX_BYTES) return badRequest("File too large — max 10 MB.");

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";
    const { url } = await uploadToCloudinary("docs", buffer, `route_map_${Date.now()}.${ext}`, file.type);

    // Append to the end of this college's list, so upload order is the display
    // order and an admin never has to think about sort numbers.
    const { data: last } = await db
      .from("route_map_attachments")
      .select("sort_order").eq("college", college)
      .order("sort_order", { ascending: false }).limit(1).maybeSingle();

    const { data, error: err } = await db
      .from("route_map_attachments")
      .insert({
        college,
        title,
        description: description || null,
        file_url: url,
        file_name: file.name,
        file_type: file.type,
        kind: file.type.startsWith("image/") ? "image" : "file",
        step_id: /^\d+$/.test(stepRaw) ? Number(stepRaw) : null,
        sort_order: (last?.sort_order ?? 0) + 1,
        created_by: user!.profileId,
      })
      .select("id, college, title, description, file_url, file_name, file_type, kind, step_id, sort_order, created_at")
      .single();

    if (err) return dbError("api/admin/route-map", err);
    return created(data);
  } catch (e) {
    // Cloudinary/internal text must never reach the client (bug #27 class).
    console.error("[api/admin/route-map]", e);
    return serverError("Upload failed. Please try again.");
  }
}
