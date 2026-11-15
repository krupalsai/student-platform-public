import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { uploadToCloudinary } from "@/lib/storage";
import { ok, forbidden, serverError, badRequest } from "@/lib/api-response";
import { ALLOWED_IMAGE_MIME } from "@/lib/image-types";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED  = ALLOWED_IMAGE_MIME as readonly string[];

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;

    if (!file)                          return badRequest("No file provided");
    if (!ALLOWED.includes(file.type))   return badRequest("Only JPEG, PNG, WebP allowed");
    if (file.size > MAX_SIZE)           return badRequest("File too large — max 10 MB");

    const buffer   = Buffer.from(await file.arrayBuffer());
    const filename = `${user!.profileId}/photo_signature_${Date.now()}`;

    const { storagePath, url } = await uploadToCloudinary(
      "docs", buffer, filename, file.type
    );

    return ok({ storage_path: storagePath, url });
  } catch (e) {
    console.error("[api/uploads/photo-signature]", e);
    return serverError();
  }
}
