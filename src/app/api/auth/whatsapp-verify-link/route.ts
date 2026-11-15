import { buildVerifyLink } from "@/lib/app-login";
import { ok, serverError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * Public, no session required. Lets /login show a proactive "message the
 * bot first" hint (with a real tappable link) BEFORE a student ever
 * requests a code — not just reactively after a failed send.
 *
 * Real gap this closes: app-login's WhatsApp send only works inside Meta's
 * 24h free-form window. Outside it, requestAppLoginOtp silently falls back
 * to push — which can report success server-side (FCM accepts it) without
 * ever actually surfacing on the device, so a returning student/admin can
 * be told "sent" and never get a code, with no visible prompt to message
 * the bot at all. Confirmed live on the owner's own account (2026-09-21):
 * an app_login_otps row was created and never deleted (push "succeeded"),
 * but no code was ever seen. This endpoint gives every visitor the same
 * "message the bot once" escape hatch the reactive needsWhatsAppVerification
 * flow already has, without waiting for that failure to happen first.
 */
export async function GET() {
  try {
    const waLink = await buildVerifyLink();
    return ok({ waLink });
  } catch (e) {
    console.error("[api/auth/whatsapp-verify-link]", e);
    return serverError();
  }
}
