import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError, zodError } from "@/lib/api-response";

const Schema = z.object({
  upi_id:               z.string().min(1).max(100).optional(),
  upi_name:             z.string().min(1).max(100).optional(),
  upi_amount:           z.number().positive().max(1000000).optional(),
  payment_notify:       z.boolean().optional(),
  payment_notify_muted: z.boolean().optional(),
  cashfree_enabled:     z.boolean().optional(),
  razorpay_enabled:     z.boolean().optional(),
  phonepe_enabled:      z.boolean().optional(),
  whatsapp_bot_enabled: z.boolean().optional(),
  route_map_enabled:    z.boolean().optional(),
  group_chat_enabled:   z.boolean().optional(),
  voice_calls_enabled:  z.boolean().optional(),
  payment_announcements_enabled: z.boolean().optional(),
  payment_nudge_enabled: z.boolean().optional(),
});

const ALL_KEYS = [
  "upi_id","upi_name","upi_amount","payment_notify","payment_notify_muted",
  "cashfree_enabled","razorpay_enabled","phonepe_enabled",
  "whatsapp_bot_enabled","route_map_enabled","group_chat_enabled","voice_calls_enabled",
  "payment_announcements_enabled","payment_nudge_enabled",
];

export async function GET(req: NextRequest) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();
  const db = createServiceClient();
  const { data, error: dbError } = await db.from("app_settings").select("key, value").in("key", ALL_KEYS);
  if (dbError) return serverError();
  const settings: Record<string, string> = {};
  (data ?? []).forEach((r: any) => { settings[r.key] = r.value; });
  if (settings.cashfree_enabled === undefined) settings.cashfree_enabled = "false";
  if (settings.razorpay_enabled === undefined) settings.razorpay_enabled = "false";
  if (settings.phonepe_enabled === undefined) settings.phonepe_enabled = "false";
  return ok(settings);
}

export async function POST(req: NextRequest) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const db = createServiceClient();
    const upserts: { key: string; value: string }[] = [];
    if (body.data.upi_id !== undefined) upserts.push({ key: "upi_id", value: body.data.upi_id });
    if (body.data.upi_name !== undefined) upserts.push({ key: "upi_name", value: body.data.upi_name });
    if (body.data.upi_amount !== undefined) upserts.push({ key: "upi_amount", value: String(body.data.upi_amount) });
    if (body.data.payment_notify !== undefined) upserts.push({ key: "payment_notify", value: String(body.data.payment_notify) });
    if (body.data.payment_notify_muted !== undefined) upserts.push({ key: "payment_notify_muted", value: String(body.data.payment_notify_muted) });
    if (body.data.cashfree_enabled !== undefined) upserts.push({ key: "cashfree_enabled", value: String(body.data.cashfree_enabled) });
    if (body.data.razorpay_enabled !== undefined) upserts.push({ key: "razorpay_enabled", value: String(body.data.razorpay_enabled) });
    if (body.data.phonepe_enabled !== undefined) upserts.push({ key: "phonepe_enabled", value: String(body.data.phonepe_enabled) });
    if (body.data.whatsapp_bot_enabled !== undefined) upserts.push({ key: "whatsapp_bot_enabled", value: String(body.data.whatsapp_bot_enabled) });
    if (body.data.route_map_enabled !== undefined) upserts.push({ key: "route_map_enabled", value: String(body.data.route_map_enabled) });
    if (body.data.group_chat_enabled !== undefined) upserts.push({ key: "group_chat_enabled", value: String(body.data.group_chat_enabled) });
    if (body.data.voice_calls_enabled !== undefined) upserts.push({ key: "voice_calls_enabled", value: String(body.data.voice_calls_enabled) });
    if (body.data.payment_announcements_enabled !== undefined) upserts.push({ key: "payment_announcements_enabled", value: String(body.data.payment_announcements_enabled) });
    if (body.data.payment_nudge_enabled !== undefined) upserts.push({ key: "payment_nudge_enabled", value: String(body.data.payment_nudge_enabled) });

    for (const row of upserts) {
      const { error: upsertError } = await db.from("app_settings").upsert(row, { onConflict: "key" });
      if (upsertError) {
        console.error("[api/admin/settings] upsert failed", row.key, upsertError);
        return serverError();
      }
    }
    return ok({ saved: true });
  } catch (err) {
    console.error("[api/admin/settings]", err);
    return serverError();
  }
}
