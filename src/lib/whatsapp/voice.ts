import { downloadWhatsAppMedia } from "@/lib/whatsapp/media";

/**
 * Voice notes → text, so students can talk to the bot instead of typing.
 *
 * Why this and not a voice bot on actual phone calls: answering a real WhatsApp
 * call with AI needs Meta's Cloud Calling API (restricted beta, gated behind a
 * 1,000+ business-initiated messaging tier) plus a self-hosted SIP/WebRTC media
 * server. A voice NOTE needs none of that — it arrives on the webhook already
 * in place, and transcription runs on the Groq key the bot already uses.
 *
 * Whisper handles Telugu, Hindi and English, including code-switching mid
 * sentence, which is how these students actually speak. The transcript then
 * goes through the SAME router as a typed message, so every answer the bot can
 * already give — FAQ, batch status, registration link, the grounded LLM — works
 * by voice with no duplicated logic and no second knowledge base to maintain.
 */

const GROQ_KEY = (process.env.GROQ_API_KEY ?? "").trim();
// turbo is ~4x faster at nearly the same accuracy, which matters because the
// student is sitting there watching a "typing…" indicator.
const MODEL = (process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo").trim();

/** WhatsApp voice notes are capped at 16MB; Groq's limit is 25MB. */
const MAX_BYTES = 25 * 1024 * 1024;

export interface TranscriptionResult {
  text: string | null;
  error?: "not_configured" | "download_failed" | "too_large" | "api_error";
}

export async function transcribeVoiceNote(mediaId: string): Promise<TranscriptionResult> {
  if (!GROQ_KEY) {
    console.warn("[voice] GROQ_API_KEY not set — voice notes cannot be transcribed");
    return { text: null, error: "not_configured" };
  }

  const media = await downloadWhatsAppMedia(mediaId);
  if (!media?.buffer) return { text: null, error: "download_failed" };
  if (media.buffer.length > MAX_BYTES) return { text: null, error: "too_large" };

  try {
    const form = new FormData();
    // WhatsApp sends audio/ogg (opus); Groq accepts ogg/opus directly, so no
    // transcoding step is needed.
    const ext = media.mimeType?.includes("mpeg") ? "mp3" : "ogg";
    form.append("file", new Blob([new Uint8Array(media.buffer)], { type: media.mimeType || "audio/ogg" }), `voice.${ext}`);
    form.append("model", MODEL);
    form.append("response_format", "json");
    // No `language` is sent on purpose: forcing one breaks the Telugu/English
    // mixing these students use. Whisper detects it per utterance.

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[voice] groq stt http ${res.status}`, body.slice(0, 300));
      return { text: null, error: "api_error" };
    }

    const json = await res.json().catch(() => null);
    const text = String(json?.text ?? "").trim();
    return { text: text || null };
  } catch (e) {
    console.error("[voice] transcription failed:", e);
    return { text: null, error: "api_error" };
  }
}

/** What the student is told when their voice note could not be understood. */
export function voiceFallbackMessage(error?: TranscriptionResult["error"]): string {
  if (error === "too_large") {
    return "That voice message is a bit too long for me. Could you send a shorter one, or type your question?";
  }
  return (
    "Sorry, I couldn't make out that voice message. 🙏\n\n" +
    "Please try recording again somewhere quieter — or just type your question and I'll answer straight away."
  );
}
