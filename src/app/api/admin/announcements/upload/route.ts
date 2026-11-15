import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/session";
import { forbidden, serverError, ok } from "@/lib/api-response";
import { uploadToCloudinary } from "@/lib/storage";
import { ALLOWED_IMAGE_MIME } from "@/lib/image-types";

// Accept PDF or DOCX only, max 10 MB
const MAX_BYTES = 10 * 1024 * 1024;
// Images included: admins attach route-map photos and notices far more often
// than they attach a Word file, and a photo previews inline in Telegram.
const ALLOWED_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  // Shared image list so an iPhone's HEIC is accepted (see lib/image-types.ts).
  ...ALLOWED_IMAGE_MIME,
];

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return serverError("No file provided");
    if (!ALLOWED_MIME.includes(file.type))
      return serverError("Only JPG, PNG, WEBP, PDF or DOCX files are allowed");
    if (file.size > MAX_BYTES)
      return serverError("File too large — max 10 MB");

    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "pdf";
    const safeName = `announcement_${Date.now()}.${ext}`;

    const { url } = await uploadToCloudinary("docs", buffer, safeName, file.type);
    return ok({ url, name: file.name });
  } catch (e) {
    // Log the real Cloudinary/internal error server-side; return a generic
    // message so provider internals never reach the client (bug #27 class).
    console.error("[api/admin/announcements/upload]", e);
    return serverError("Upload failed. Please try again.");
  }
}
