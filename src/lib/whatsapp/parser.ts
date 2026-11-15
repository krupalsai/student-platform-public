/**
 * Parses Meta's WhatsApp webhook payload into the shape the router
 * actually needs. Pure extraction — no business logic, no sending.
 */
export interface ParsedWhatsAppMessage {
  /** Meta's globally-unique message id (wamid). Used to dedupe webhook
   *  retries — Meta re-delivers a message if it doesn't get a fast 200. */
  id: string | null;
  /** Raw phone as WhatsApp sends it (e.g. "9198XXXXXXXX") — pass straight through to services, they normalize. */
  from: string;
  /** Free text typed by the student, or the title of a tapped list/button row as a fallback. Null for anything else. */
  text: string | null;
  /** The id of a tapped list row or reply button, if this message was a menu selection. Null for free text. */
  selectionId: string | null;
  /** Meta media id, if this message was a photo. Null for everything else. Fetch the actual bytes via /lib/whatsapp/media.ts — the id alone isn't a URL. */
  imageId: string | null;
  /** Meta media id of a voice note / audio message. Transcribed by /lib/whatsapp/voice.ts, then handled exactly like typed text. */
  audioId: string | null;
  /** Meta media id of a PDF/DOC attachment. Only admins act on this (relaying a
   *  file to a student); a student's document still falls through to their
   *  caption text, as before. Optional so existing construction sites — tests
   *  included — keep compiling. */
  documentId?: string | null;
  /** Original filename Meta reports for a document, when it gives one. */
  documentFilename?: string | null;
  /** The sender's WhatsApp display name (pushname) Meta reports in
   *  `value.contacts[0].profile.name`, when it gives one. Used to greet
   *  senders by name even before they register — never stored as their
   *  registered name. Optional so existing construction sites — tests
   *  included — keep compiling. */
  profileName?: string | null;
}

export function parseIncomingWhatsApp(payload: unknown): ParsedWhatsAppMessage | null {
  const p = payload as any;
  const msg = p?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg?.from) return null;

  const id = msg.id ?? null;
  const rawProfileName = p?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;
  const profileName =
    typeof rawProfileName === "string" && rawProfileName.trim() ? rawProfileName.trim() : null;

  if (msg.type === "text") {
    return { id, from: msg.from, text: msg.text?.body ?? null, selectionId: null, imageId: null, audioId: null, profileName };
  }

  if (msg.type === "interactive") {
    const sel = msg.interactive?.list_reply ?? msg.interactive?.button_reply;
    if (sel) return { id, from: msg.from, text: sel.title ?? null, selectionId: sel.id ?? null, imageId: null, audioId: null, profileName };
  }

  if (msg.type === "image" && msg.image?.id) {
    return { id, from: msg.from, text: msg.image?.caption ?? null, selectionId: null, imageId: msg.image.id, audioId: null, profileName };
  }

  if (msg.type === "document" && msg.document?.id) {
    return {
      id, from: msg.from, text: msg.document?.caption ?? null, selectionId: null,
      imageId: null, audioId: null,
      documentId: msg.document.id,
      documentFilename: msg.document?.filename ?? null,
      profileName,
    };
  }

  if ((msg.type === "audio" || msg.type === "voice") && (msg.audio?.id || msg.voice?.id)) {
    return {
      id, from: msg.from, text: null, selectionId: null, imageId: null,
      audioId: msg.audio?.id ?? msg.voice?.id,
      profileName,
    };
  }

  return { id, from: msg.from, text: null, selectionId: null, imageId: null, audioId: null, profileName };
}
