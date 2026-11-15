/**
 * Records each incoming WhatsApp text so the intent classifier can be tested
 * against real messages. Best-effort: a logging failure must never block a
 * reply, so every error is swallowed after a console warning.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function logIncomingMessage(
  db: SupabaseClient,
  phone: string,
  senderRole: "admin" | "student" | "unknown",
  message: string,
  meta: { label?: string | null; route?: string | null; replyPreview?: string | null } = {},
): Promise<void> {
  try {
    const text = message.trim().slice(0, 1000);
    if (!text) return;
    const { error } = await db.from("bot_message_log").insert({
      phone,
      sender_role: senderRole,
      message: text,
      label: meta.label ?? null,
      route: meta.route ?? null,
      reply_preview: meta.replyPreview ? meta.replyPreview.slice(0, 300) : null,
    });
    if (error) console.warn("[message-log] insert failed", error.message);
  } catch (e) {
    console.warn("[message-log] skipped", (e as Error).message);
  }
}
