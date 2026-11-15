import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ok, serverError } from "@/lib/api-response";
import { getActivePaymentGateway } from "@/lib/services/payment-settings";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

// Keys any visitor may see: the pay page (/pay/[slug]) and the registration
// page both fetch this endpoint WITHOUT a session and only need to know
// which gateway is live. The owner's UPI
// identity (upi_id / upi_name) is NOT in this list.
const PUBLIC_KEYS = [
  "upi_amount",
  "cashfree_enabled",
  "razorpay_enabled",
  "phonepe_enabled",
  "route_map_enabled",
  "group_chat_enabled",
  "voice_calls_enabled",
];

export async function GET(req: NextRequest) {
  try {
    const db = createServiceClient();
    const { data, error } = await db.from("app_settings")
      .select("key, value")
      .in("key", [
        "upi_id",
        "upi_name",
        "upi_amount",
        "cashfree_enabled",
        "razorpay_enabled",
        "phonepe_enabled",
        "route_map_enabled",
        "group_chat_enabled",
        "voice_calls_enabled",
      ]);
    if (error) return serverError();

    const settings: Record<string, string> = {};
    (data ?? []).forEach((r: any) => { settings[r.key] = r.value; });

    if (settings.cashfree_enabled === undefined) settings.cashfree_enabled = "false";
    if (settings.razorpay_enabled === undefined) settings.razorpay_enabled = "false";
    if (settings.phonepe_enabled === undefined) settings.phonepe_enabled = "false";
    if (settings.route_map_enabled === undefined) settings.route_map_enabled = "true";
    if (settings.group_chat_enabled === undefined) settings.group_chat_enabled = "true";
    if (settings.voice_calls_enabled === undefined) settings.voice_calls_enabled = "true";

    // The single computed answer to "which gateway is actually live right
    // now" — /pay/[slug] reads THIS, not the three raw flags, so it can
    // never disagree with getActivePaymentGateway()'s own priority-order
    // tie-break (item #178).
    (settings as Record<string, string | null>).active_gateway = await getActivePaymentGateway(db);

    // Security fix (2026-10-26): this endpoint used to return the owner's
    // UPI id/name to anyone on the internet, no login needed. Unauthenticated
    // callers now get only the public keys above; the full settings —
    // including upi_id / upi_name — are returned only to a signed-in session
    // (the pay page shows the UPI details to a logged-in student).
    const user = await getSession(req);
    if (!user) {
      const publicSettings: Record<string, string> = {};
      for (const key of PUBLIC_KEYS) {
        if (settings[key] !== undefined) publicSettings[key] = settings[key];
      }
      publicSettings.active_gateway = settings.active_gateway;
      return ok(publicSettings);
    }

    return ok(settings);
  } catch (err) {
    console.error("[api/settings]", err);
    return serverError();
  }
}
