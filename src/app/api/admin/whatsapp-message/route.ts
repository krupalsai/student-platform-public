import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, zodError } from "@/lib/api-response";
import { audit } from "@/lib/audit";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";

/**
 * POST /api/admin/whatsapp-message — sends one WhatsApp text to one explicit
 * phone number. This is not a new capability: it's an HTTP front door onto
 * the exact same `sendWhatsAppText` the admin's own WhatsApp `MESSAGE <phone>
 * <text>` command already uses (bug #33/#58) — just reachable without
 * texting the bot from the admin's own phone first.
 *
 * Built to send a direct catch-up reply to a real student whose message hit
 * the whatsapp_monthly_usage grant bug (item #206) and never got an answer,
 * since no existing route can message one specific phone outside of a
 * batch/all-admins broadcast. super_admin only, same tier as
 * `whatsapp-broadcast`.
 */
const Schema = z.object({
  phone: z.string().min(10).max(15),
  message: z.string().min(1).max(4096),
});

export async function POST(req: NextRequest) {
  const { user, error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  const body = Schema.safeParse(await req.json());
  if (!body.success) return zodError(body.error);

  const to = normalizeWhatsAppNumber(body.data.phone);
  const sent = await sendWhatsAppText(to, body.data.message);

  await audit(
    "whatsapp.broadcast",
    "whatsapp_contact",
    to,
    { sent, single_message: true },
    user!.profileId,
    "admin",
  );

  return ok({ sent });
}
