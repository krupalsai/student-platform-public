"use server";

import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError, badRequest } from "@/lib/api-response";

// Accept POST multipart/form-data with file field 'file'
// DELETE resets to default

const BUCKET = "app-assets";
const OBJECT_PATH = "pwa/student-icon.png";

function isPng(bytes: Uint8Array) {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
}
function isJpeg(bytes: Uint8Array) {
  return bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
}
function isWebp(bytes: Uint8Array) {
  // RIFF....WEBP
  return bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

export async function POST(req: NextRequest) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data")) return badRequest("Expected multipart/form-data");
    const formData = await req.formData();
    const file = formData.get("file") as any;
    if (!file) return badRequest("No file uploaded");
    const maxSize = 1_000_000; // 1 MB
    if ((file as any).size > maxSize) return badRequest("File too large (max 1 MB)");

    const arrayBuffer = await (file as any).arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    if (!(isPng(bytes) || isJpeg(bytes) || isWebp(bytes))) return badRequest("Unsupported image type — only PNG, JPEG, WebP allowed");

    const db = createServiceClient();
    // upload to storage
    const storage = db.storage;
    // convert to Node Buffer for supabase-js upload in Node
    const buf = Buffer.from(arrayBuffer);
    const contentTypeHeader = isPng(bytes) ? "image/png" : isJpeg(bytes) ? "image/jpeg" : "image/webp";

    const uploadRes = await storage.from(BUCKET).upload(OBJECT_PATH, buf, { upsert: true, contentType: contentTypeHeader, cacheControl: "31536000" });
    if (uploadRes.error) { console.error("[icon upload]", uploadRes.error); return serverError(); }

    const { data: publicUrlData } = storage.from(BUCKET).getPublicUrl(OBJECT_PATH);
    // The object path never changes between uploads (upsert overwrites the
    // same key), so without a cache-buster every re-upload keeps serving
    // whatever the browser/CDN cached under this exact URL the first time —
    // "I uploaded a new icon but it still shows the old one". The version
    // query param makes each upload a distinct URL, forcing a real fetch.
    const publicUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;

    // store in app_settings
    const upsert = await db.from("app_settings").upsert({ key: "pwa_student_icon_url", value: publicUrl }, { onConflict: "key" });
    if (upsert.error) { console.error("[icon db upsert]", upsert.error); return serverError(); }

    return ok({ url: publicUrl });
  } catch (err) { console.error("[api/admin/settings/icon POST]", err); return serverError(); }
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();
    const storage = db.storage;
    // remove object if exists
    const del = await storage.from(BUCKET).remove([OBJECT_PATH]);
    if (del.error) console.warn("[icon delete] storage remove returned error", del.error);
    const rem = await db.from("app_settings").delete().eq("key", "pwa_student_icon_url");
    if (rem.error) { console.error("[icon db delete]", rem.error); return serverError(); }
    return ok({ deleted: true });
  } catch (err) { console.error("[api/admin/settings/icon DELETE]", err); return serverError(); }
}
