import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";

const UPI_KEYS = ["upi_id", "upi_payee_name", "default_payment_note"] as const;

// Payment/UPI config — same category as the Settings page (also
// super_admin-only). Not currently linked from any admin UI page, but
// restricted deliberately rather than left as plain 'admin' by default.

/** GET /api/admin/payment-settings — returns current UPI config */
export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user || user.role !== "super_admin") return forbidden();
  try {
    const db = createServiceClient();
    const { data } = await db.from("app_settings").select("key, value").in("key", UPI_KEYS as unknown as string[]);
    const settings: Record<string, string> = {};
    for (const row of data ?? []) settings[row.key] = row.value;
    return ok(settings);
  } catch (e) { return serverError(); }
}

/** PATCH /api/admin/payment-settings — update UPI config */
export async function PATCH(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user || user.role !== "super_admin") return forbidden();
  try {
    const body = await req.json();
    const db = createServiceClient();
    for (const key of UPI_KEYS) {
      if (body[key] !== undefined) {
        await db.from("app_settings").upsert({ key, value: String(body[key]) });
      }
    }
    return ok({ updated: true });
  } catch (e) { return serverError(); }
}
