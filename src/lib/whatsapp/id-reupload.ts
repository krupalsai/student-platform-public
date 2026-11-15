/**
 * WhatsApp-side College ID re-upload — same one-time correction the web/
 * Telegram Mini App already offers via /api/profile/reupload-id, for
 * students who only ever interact through WhatsApp.
 *
 * Flow:
 *   Student: "REUPLOAD ID" (or similar phrasing)
 *     -> eligibility checked (registered? not already used their one shot?)
 *     -> awaiting_id_reupload set, bot asks for the photo
 *   Student: sends a photo
 *     -> consumeAwaitingIdReupload() confirms this IS the expected reply
 *     -> downloaded from Meta, uploaded to the same Cloudinary "docs"
 *        bucket the web upload uses, then SCANNED first (11 Nov 2026):
 *        if the photo is not an ID card, or it has no visible signature,
 *        it is deleted and NOT saved — the student is told how to fix it
 *        (sign on paper next to the card) and their one-time re-upload
 *        is NOT consumed, so they can send a better photo. Only a photo
 *        that passes (or one the scan itself couldn't run on) is saved
 *        to the profile, the old file cleaned up, audit logged — identical
 *        end state to the web route.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/services/students";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { downloadWhatsAppMedia } from "@/lib/whatsapp/media";
import { setAwaitingIdReupload, consumeAwaitingIdReupload } from "@/lib/whatsapp/moderation";
import { uploadToCloudinary, deleteStoredAsset } from "@/lib/storage";
import { audit } from "@/lib/audit";
import { verifyCollegeId } from "@/lib/id-ocr";

const TRIGGER = /^(re-?upload|correct|edit|fix|change)\s*(my\s*)?(college\s*)?id\b/i;

/** True if this text should start the re-upload flow — call before falling through to other text handling. */
export function isIdReuploadTrigger(text: string): boolean {
  return TRIGGER.test(text.trim());
}

export async function startIdReuploadFlow(db: SupabaseClient, waFrom: string, phone: string): Promise<void> {
  const p = normalizePhone(phone);
  const { data: profile } = await db
    .from("profiles")
    .select("id, is_profile_complete, college_id_reupload_used")
    .eq("phone", p)
    .maybeSingle();

  if (!profile || !profile.is_profile_complete) {
    await sendWhatsAppText(waFrom, "I can't find a completed registration for this number yet — finish registering first, then you'll be able to re-upload your College ID if needed.");
    return;
  }

  if (profile.college_id_reupload_used) {
    await sendWhatsAppText(waFrom, "You've already used your one-time College ID re-upload. For any further change, please contact the admin directly.");
    return;
  }

  await setAwaitingIdReupload(db, p);
  await sendWhatsAppText(
    waFrom,
    "📄 Send a clear photo of your College ID now — make sure your *signature* is visible on it. This will replace your current upload (one-time correction)."
  );
}

/** Call when an image arrives and the student had been asked for one. Returns true if it consumed/handled the image (whether it succeeded or not) — false means this image wasn't part of a re-upload flow and the caller should handle it some other way. */
export async function handleIncomingIdReuploadImage(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  mediaId: string
): Promise<boolean> {
  const p = normalizePhone(phone);
  const isExpected = await consumeAwaitingIdReupload(db, p);
  if (!isExpected) return false;

  const { data: profile } = await db
    .from("profiles")
    .select("id, college_id_path, college_id_reupload_used")
    .eq("phone", p)
    .maybeSingle();

  if (!profile) {
    await sendWhatsAppText(waFrom, "Something went wrong finding your registration — please contact admin.");
    return true;
  }
  // Re-check the lock — guards the rare case of two re-upload requests racing.
  if (profile.college_id_reupload_used) {
    await sendWhatsAppText(waFrom, "You've already used your one-time College ID re-upload. For any further change, please contact the admin directly.");
    return true;
  }

  const media = await downloadWhatsAppMedia(mediaId);
  if (!media) {
    await sendWhatsAppText(waFrom, "❌ Couldn't download that photo — please try sending it again.");
    return true;
  }

  const filename = `${profile.id}/college_id_${Date.now()}`;
  const { storagePath, url } = await uploadToCloudinary("docs", media.buffer, filename, media.mimeType);

  // Scan FIRST, before accepting the photo (11 Nov 2026): the old flow
  // saved the photo as the student's ID and only scanned afterwards, so
  // a photo with no signature became their ID on file and burned their
  // one-time re-upload. Now the photo is only saved if it passes (or if
  // the scan itself couldn't run — don't block on an infrastructure gap).
  // A rejected photo is deleted and does NOT consume the one-time
  // re-upload, so the student can send a better one.
  let aiCheck: { isIdCard: boolean; hasSignature: boolean; notes: string | null } | null = null;
  try {
    aiCheck = await verifyCollegeId(url);
  } catch (e) {
    console.error("[wa-id-reupload] AI check failed:", (e as Error).message);
    aiCheck = null;
  }

  if (aiCheck && !aiCheck.isIdCard) {
    await deleteStoredAsset("docs", storagePath).catch(() => {});
    await sendWhatsAppText(
      waFrom,
      "⚠️ That photo doesn't look like a College ID card, so I haven't saved it — your one-time re-upload is still available. Please send a clear photo of your actual College ID. If your card has no signature on it, sign your name on a blank paper, place it next to the card, and photograph both together."
    );
    return true;
  }

  if (aiCheck && aiCheck.isIdCard && !aiCheck.hasSignature) {
    await deleteStoredAsset("docs", storagePath).catch(() => {});
    await sendWhatsAppText(
      waFrom,
      "⚠️ The signature still doesn't look visible on that photo, so I haven't saved it — your one-time re-upload is still available. Sign your name on a blank paper, place it next to the card, and photograph both together, then send that photo."
    );
    return true;
  }

  const { error: updateErr } = await db.from("profiles").update({
    college_id_path: storagePath,
    college_id_ai_flag: aiCheck,
    college_id_reupload_used: true,
    college_id_reupload_used_at: new Date().toISOString(),
  }).eq("id", profile.id);

  if (updateErr) {
    console.error("[wa-id-reupload] update failed", updateErr.message);
    await sendWhatsAppText(waFrom, "❌ Couldn't save your College ID — please try again or contact admin.");
    return true;
  }

  if (profile.college_id_path && profile.college_id_path !== storagePath) {
    await deleteStoredAsset("docs", profile.college_id_path).catch(() => {});
  }

  await audit("student.college_id_reuploaded", "profile", profile.id, {
    previous_path: profile.college_id_path,
    new_path: storagePath,
    channel: "whatsapp",
  }, profile.id, "student");

  await sendWhatsAppText(waFrom, "✅ Got it — your College ID has been updated.");

  return true;
}
