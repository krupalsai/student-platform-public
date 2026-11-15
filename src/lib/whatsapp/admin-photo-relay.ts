import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText, sendWhatsAppImage, sendWhatsAppDocument } from "@/lib/whatsapp/client";
import { downloadWhatsAppMedia } from "@/lib/whatsapp/media";
import { uploadToCloudinary } from "@/lib/storage";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";
import { resolveStudentByNamePrefix, maskPhone } from "@/lib/whatsapp/recipient-lookup";

/**
 * Admin sends a photo to ONE student, from WhatsApp.
 *
 * The admin photographs a receipt, a corrected form, a notice — whatever — and
 * sends it to the bot with the caption:
 *
 *     MESSAGE 9876543210 here is your receipt
 *
 * and the bot relays the image, with the text, to that student.
 *
 * Why the round trip through Cloudinary: Meta gives us a media ID, not a URL,
 * and the send API needs a publicly fetchable link (Meta's servers fetch it,
 * not the student's phone). Re-uploading is the only way to turn one into the
 * other. It also means the file survives Meta's short media retention, so a
 * failed send can be retried.
 *
 * SUPER_ADMIN is not required — any admin can already message a student with
 * text, and a photo is the same act.
 */

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Cloudinary stores raw files under the extension we give it, and the student's
 * phone decides how to open the download from that extension — so guessing
 * "pdf" for every non-image would hand them a broken DOCX. Prefer the real
 * filename's extension, fall back to the mime subtype.
 */
export function extFor(mimeType: string | undefined, filename: string | null | undefined, isImage: boolean): string {
  const fromName = filename?.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  const sub = (mimeType ?? "").split("/")[1]?.split(";")[0]?.trim() ?? "";
  if (/^[a-z0-9]{1,5}$/.test(sub)) return sub;
  return isImage ? "jpg" : "bin";
}

export interface RelayResult {
  handled: boolean;
  ok?: boolean;
  message?: string;
}

/** What a caption turned out to be. Pure, so it can be pinned by a test. */
export type RelayCommand =
  | { kind: "not_a_command" }
  | { kind: "malformed" }
  | { kind: "bad_phone"; phone: string }
  | { kind: "ok"; phone: string; body: string }
  | { kind: "needs_name"; text: string };

/**
 * Reads "MESSAGE <phone> <text>" — or, now, "MESSAGE <student name> <text>"
 * — out of an attachment's caption.
 *
 * Split out from the send path because every historical bug here was in the
 * parse, not the send: bug #33 corrupted a real 10-digit mobile starting with
 * 91, and a bare "MESSAGE" used to fall through to "Unknown command". This
 * stays a pure, DB-free function — the leading token only decides whether it
 * LOOKS like a phone number (digits/spaces/dashes) or a name; actually
 * resolving a name against profiles.full_name needs a DB call and happens in
 * the caller (relayAdminMediaToStudent / admin.ts's MESSAGE handler) via
 * resolveStudentByNamePrefix, so it can be reused by both.
 */
export function parseRelayCommand(caption: string | null): RelayCommand {
  const text = (caption ?? "").trim();
  if (!/^MESSAGE\b/i.test(text)) return { kind: "not_a_command" };

  const rest = text.replace(/^MESSAGE\s*/i, "").trim();
  if (!rest) return { kind: "malformed" };

  const m = rest.match(/^(\+?[\d\s-]{7,15})\s*([\s\S]*)$/);
  if (!m) return { kind: "needs_name", text: rest };

  // Strip a 91 country code only from the 12-digit form — a real 10-digit
  // mobile can legitimately start with 91 (bug #33).
  const digits = m[1].replace(/\D/g, "");
  const phone = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (phone.length !== 10) return { kind: "bad_phone", phone };

  return { kind: "ok", phone, body: (m[2] ?? "").trim() };
}

/**
 * Handles an admin's image/document whose caption is a MESSAGE command.
 * Returns { handled: false } when the caption isn't one, so normal image
 * handling still runs.
 */
export async function relayAdminMediaToStudent(
  db: SupabaseClient,
  waFrom: string,
  caption: string | null,
  mediaId: string,
  originalFilename?: string | null,
): Promise<RelayResult> {
  const cmd = parseRelayCommand(caption);
  if (cmd.kind === "not_a_command") return { handled: false };

  if (cmd.kind === "malformed") {
    await sendWhatsAppText(
      waFrom,
      "📷 *Send a photo to one student*\n\nSend the photo with this caption:\n" +
      "*MESSAGE 9876543210 your message*\n\nThe number first, then what you want to say.",
    );
    return { handled: true, ok: false };
  }

  if (cmd.kind === "bad_phone") {
    await sendWhatsAppText(waFrom, "❌ That doesn't look like a 10-digit mobile number.");
    return { handled: true, ok: false };
  }

  let phone: string;
  let body: string;
  let who = "";

  if (cmd.kind === "needs_name") {
    const resolution = await resolveStudentByNamePrefix(db, cmd.text);
    if (resolution.kind === "none") {
      await sendWhatsAppText(
        waFrom,
        "📷 *Send a photo to one student*\n\nSend the photo with this caption:\n" +
        "*MESSAGE 9876543210 your message*\nor *MESSAGE <student's full name> your message*\n\n" +
        "I couldn't find a registered student by that name — check the spelling or use their phone number instead.",
      );
      return { handled: true, ok: false };
    }
    if (resolution.kind === "ambiguous") {
      const list = resolution.matches.map((m) => `• ${m.full_name} (${maskPhone(m.phone)})`).join("\n");
      await sendWhatsAppText(
        waFrom,
        `⚠️ More than one student is named *${resolution.nameQuery}*:\n\n${list}\n\nPlease resend using the full phone number instead.`,
      );
      return { handled: true, ok: false };
    }
    phone = resolution.match.phone;
    body = resolution.body;
    who = resolution.match.full_name;
  } else {
    // cmd.kind === "ok"
    phone = cmd.phone;
    body = cmd.body;
    // Who is this? An admin types the number by hand, and a typo would send a
    // student's receipt to a stranger. Naming the recipient back makes that
    // visible. Best-effort only — never block the send on it.
    try {
      const { data: profileId } = await db.rpc("find_profile_by_normalized_phone", { p_phone: phone });
      if (profileId) {
        const { data: prof } = await db.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
        if (prof?.full_name) who = prof.full_name;
      }
    } catch (e) {
      console.error("[admin-photo-relay] name lookup failed", e);
    }
  }

  try {
    const media = await downloadWhatsAppMedia(mediaId);
    if (!media?.buffer?.length) {
      await sendWhatsAppText(waFrom, "❌ I couldn't download that photo from WhatsApp. Please try sending it again.");
      return { handled: true, ok: false };
    }
    if (media.buffer.length > MAX_BYTES) {
      await sendWhatsAppText(waFrom, "❌ That file is too large — the limit is 10 MB.");
      return { handled: true, ok: false };
    }

    const isImage = (media.mimeType ?? "").startsWith("image/");
    const ext = extFor(media.mimeType, originalFilename, isImage);
    const { url } = await uploadToCloudinary(
      "docs",
      media.buffer,
      `admin_relay_${Date.now()}.${ext}`,
      media.mimeType || "image/jpeg",
    );

    const to = normalizeWhatsAppNumber(phone);
    const sent = isImage
      ? await sendWhatsAppImage(to, url, body || undefined)
      : await sendWhatsAppDocument(to, url, originalFilename || `document.${ext}`, body || undefined);

    if (!sent) {
      await sendWhatsAppText(
        waFrom,
        `❌ Couldn't deliver to +91${phone}.\n\nWhatsApp only allows this within 24 hours of *their* last message. ` +
        `Ask them to send you anything first, then try again.`,
      );
      return { handled: true, ok: false };
    }

    await sendWhatsAppText(
      waFrom,
      `✅ ${isImage ? "Photo" : "File"} sent to ${who ? `*${who}* (+91${phone})` : `+91${phone}`}` +
      `${body ? " with your message" : ""}.` +
      (who ? "" : "\n\n⚠️ That number isn't a registered student — double-check it."),
    );
    return { handled: true, ok: true };
  } catch (e) {
    // Never leak Cloudinary/internal text to an admin chat (bug #27 class).
    console.error("[admin-photo-relay]", e);
    await sendWhatsAppText(waFrom, "❌ Something went wrong sending that photo. Please try again.");
    return { handled: true, ok: false };
  }
}
