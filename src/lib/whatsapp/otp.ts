/**
 * OTP delivery over WhatsApp — used ONLY by the registration flow now
 * (src/app/api/registration-tokens/request-otp/route.ts). The login flow
 * never sends a WhatsApp code proactively: WhatsApp only delivers inside
 * the 24h window after the student messages the bot, so the login code
 * goes out solely as a reply to the student's own VERIFY message (see
 * whatsapp/verify-code.ts), which opens the window by construction.
 *
 * Tries a Meta-approved OTP template first (env WHATSAPP_OTP_TEMPLATE_NAME /
 * WHATSAPP_OTP_TEMPLATE_LANGUAGE), which delivers outside the 24h
 * customer-service window. Falls back to free-form text, which only reaches
 * people who messaged the bot in the last 24h — Meta silently drops the rest
 * (error 131047), so callers must not treat "accepted" as "delivered".
 *
 * Free-form sends consume the monthly service-message allowance
 * (WHATSAPP_SERVICE_MONTHLY_LIMIT, default 1000) enforced inside
 * sendWhatsAppText; template sends are tracked separately.
 */
import { sendWhatsAppText, sendWhatsAppTemplate } from "@/lib/whatsapp/client";

export function isWhatsAppOtpConfigured(): boolean {
  return !!(
    process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() && process.env.WHATSAPP_ACCESS_TOKEN?.trim()
  );
}

/**
 * "template" = accepted via the approved OTP template (reaches students
 * outside the 24h window). "text" = accepted as free-form text only, which
 * Meta silently drops for anyone who has not messaged the bot in 24h, so it
 * must NOT be treated as delivered — callers should still send SMS.
 */
export type WhatsAppOtpResult = "template" | "text" | false;

export async function sendWhatsAppOtp(phone: string, otp: string): Promise<WhatsAppOtpResult> {
  if (!isWhatsAppOtpConfigured()) return false;

  const templateName = process.env.WHATSAPP_OTP_TEMPLATE_NAME?.trim() ?? "";
  const templateLanguage = process.env.WHATSAPP_OTP_TEMPLATE_LANGUAGE?.trim() || "en";
  if (templateName) {
    if (await sendWhatsAppTemplate(phone, templateName, templateLanguage, [otp, "5"])) {
      return "template";
    }
    console.error("[whatsapp-otp] template send failed, falling back to free-form text");
  } else {
    console.warn("[whatsapp-otp] WHATSAPP_OTP_TEMPLATE_NAME is not set; free-form text only reaches students inside the 24h window");
  }

  const sent = await sendWhatsAppText(
    phone,
    `🔐 Student Platform login code: *${otp}*\n\nThis code expires in 5 minutes. Do not share this code with anyone.`
  );
  return sent ? "text" : false;
}
