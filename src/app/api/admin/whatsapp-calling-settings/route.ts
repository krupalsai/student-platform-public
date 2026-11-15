import { NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { audit } from "@/lib/audit";

/**
 * GET/POST /api/admin/whatsapp-calling-settings — reads and enables WhatsApp
 * Calling on this app's own business phone number via Meta's Settings API
 * (`/{PHONE_NUMBER_ID}/settings`, confirmed against Meta's current docs —
 * "Calling is not enabled by default on a business phone number," and the
 * `calling.status` field is genuinely API-settable, not WhatsApp-Manager-UI
 * only as TODO #15 originally assumed).
 *
 * TODO #15 turned out to be fixable from here, not a pure human task — this
 * route is that fix. `call_events` had zero rows ever (confirmed live before
 * building this): no inbound call had ever reached our webhook, consistent
 * with calling never having been turned on for the number at all.
 *
 * super_admin only, same tier as `payment-settings` (item #63) — this
 * changes a live setting on the business's actual WhatsApp account.
 */
const GRAPH_VERSION = "v20.0";

function creds() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) return null;
  return { phoneNumberId, accessToken };
}

export async function GET(req: NextRequest) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  const c = creds();
  if (!c) return serverError("WhatsApp credentials are not configured.");

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${c.phoneNumberId}/settings`,
      { headers: { Authorization: `Bearer ${c.accessToken}` } },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      console.error("[whatsapp-calling-settings] GET failed", json);
      return serverError(json?.error?.message ?? `Meta returned HTTP ${res.status}`);
    }
    return ok({ calling: json?.calling ?? null, raw: json });
  } catch (e) {
    console.error("[whatsapp-calling-settings] GET error", e);
    return serverError();
  }
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  const c = creds();
  if (!c) return serverError("WhatsApp credentials are not configured.");

  const body = await req.json().catch(() => ({}));
  const enable = body?.enable !== false; // default true: this route's only real use is turning it on

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${c.phoneNumberId}/settings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${c.accessToken}`,
        },
        body: JSON.stringify({ calling: { status: enable ? "ENABLED" : "DISABLED" } }),
      },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message ?? `Meta returned HTTP ${res.status}`;
      console.error("[whatsapp-calling-settings] POST failed", json);
      return serverError(msg);
    }

    await audit(
      "whatsapp.calling_settings_changed",
      "platform",
      null,
      { enabled: enable },
      user!.profileId,
      "admin",
    );

    return ok({ success: json?.success ?? true, enabled: enable });
  } catch (e) {
    console.error("[whatsapp-calling-settings] POST error", e);
    return serverError();
  }
}
