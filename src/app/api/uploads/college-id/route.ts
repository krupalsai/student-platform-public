import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { uploadToCloudinary } from "@/lib/storage";
import { createServiceClient } from "@/lib/supabase/server";
import { verifyCollegeId } from "@/lib/id-ocr";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { setAwaitingIdReupload } from "@/lib/whatsapp/moderation";
import { ok, forbidden, serverError, badRequest } from "@/lib/api-response";
import { mapUploadError } from "@/lib/upload-errors";
import { ALLOWED_IMAGE_MIME } from "@/lib/image-types";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED  = ALLOWED_IMAGE_MIME as readonly string[];

// Default Vercel function timeout is 10s — a phone-camera photo (up to 5MB)
// uploading over mobile data can easily take longer than that, especially
// on patchy 4G/5G. That produces exactly this failure mode: student sees a
// generic "internal server error" on Save & Continue with no useful detail,
// because Vercel kills the function before our own error handling even runs.
// Give this route real headroom.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;

    if (!file)              return badRequest("No file provided");
    if (!ALLOWED.includes(file.type)) return badRequest("Only JPEG, PNG, WebP allowed");
    if (file.size > MAX_SIZE)         return badRequest("File too large — max 10 MB");

    const buffer   = Buffer.from(await file.arrayBuffer());
    const filename = `${user!.profileId}/college_id_${Date.now()}`;

    // A throw here is the storage provider (Cloudinary) being unavailable
    // or misconfigured — a downstream outage, not a generic 500. Answer a
    // distinct 503 with a retryable message so the student isn't blocked by
    // a cryptic "Internal server error" (shown twice: under the photo and
    // in the save banner), and the provider's own error is logged for
    // diagnosis. Live incident 11 Nov 2026: "Invalid cloud_name" 500'd
    // every upload after a key rotation whose cloud didn't match
    // CLOUDINARY_CLOUD_NAME; the fix for that is the env value, this keeps
    // the next such failure diagnosable and retryable.
    let storagePath: string;
    let url: string;
    try {
      ({ storagePath, url } = await uploadToCloudinary(
        "docs", buffer, filename, file.type
      ));
    } catch (e) {
      console.error("[api/uploads/college-id] storage upload failed:", (e as Error).message);
      const r = mapUploadError(e);
      return NextResponse.json(r.body, { status: r.status });
    }

    // Run the AI-assist check synchronously now — this is the registration
    // page's chance to warn the student BEFORE they move to the next step,
    // which is far better than only catching it later via the background
    // WhatsApp nudge (kept below as a safety net for anyone who proceeds
    // anyway, and for the WhatsApp-only registration path where there's no
    // "page" to show a warning on).
    const aiCheck = await verifyCollegeId(url).catch((e) => {
      console.error("[api/uploads/college-id] AI check failed:", (e as Error).message);
      return null;
    });

    const db = createServiceClient();
    if (aiCheck) {
      // MUST be awaited. Unawaited, this write is killed when the serverless
      // lambda freezes after the response — production had 27 uploaded College
      // IDs and 0 saved flags, so every AI check was paid for and discarded,
      // and no admin ever saw one.
      const { error: flagErr } = await db
        .from("profiles").update({ college_id_ai_flag: aiCheck }).eq("id", user!.profileId);
      if (flagErr) console.error("[api/uploads/college-id] flag save failed:", flagErr.message);
    }

    // Fallback nudge — only relevant if the student proceeds past the
    // inline warning (or is registering via WhatsApp, which has no upload
    // page at all). Fire-and-forget; never blocks the response.
    // Also awaited, for the same reason: "fire-and-forget" on Vercel means
    // "never runs". This nudge is the whole automatic signature check the
    // admin relies on, and it was silently never sending.
    if (aiCheck && aiCheck.isIdCard && !aiCheck.hasSignature) {
      try {
        const { data: profile } = await db.from("profiles")
          .select("phone, college_id_reupload_used")
          .eq("id", user!.profileId)
          .maybeSingle();
        if (profile?.phone && !profile.college_id_reupload_used) {
          await setAwaitingIdReupload(db, profile.phone);
          await sendWhatsAppText(
            profile.phone,
            "⚠️ We noticed your College ID photo doesn't clearly show a signature. " +
            "Please send a new photo of your College ID right here — make sure the signature is visible. " +
            "If your card has no signature on it, sign your name on a blank paper, place it next to the card, and photograph both together. " +
            "This replaces your upload (one-time correction)."
          );
        }
      } catch (e) {
        console.error("[api/uploads/college-id] nudge failed:", (e as Error).message);
      }
    }

    return ok({ storage_path: storagePath, url, ai_check: aiCheck });
  } catch (e) {
    console.error("[api/uploads/college-id]", e);
    return serverError();
  }
}
