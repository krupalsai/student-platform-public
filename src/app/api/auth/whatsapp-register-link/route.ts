import { buildRegisterLink } from "@/lib/app-login";
import { ok, serverError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * Public, no session required. Lets /login offer a registration start to a
 * visitor whose number is not registered — registration starts ONLY via the
 * WhatsApp bot, so the link opens WhatsApp with "Register" pre-filled (the
 * bot's own registration trigger). Returns { waLink: string | null }; null
 * when the bot number can't be resolved, and the page then shows a text
 * fallback instead of a dead link.
 */
export async function GET() {
  try {
    const waLink = await buildRegisterLink();
    return ok({ waLink });
  } catch (e) {
    console.error("[api/auth/whatsapp-register-link]", e);
    return serverError();
  }
}
