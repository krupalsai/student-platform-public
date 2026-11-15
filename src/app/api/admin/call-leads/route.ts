import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { isMissingLeadsTable } from "@/lib/whatsapp/missed-call-leads";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * GET /api/admin/call-leads — missed-call leads (migration 0094), newest
 * first, for /admin/call-leads. Before the migration is pasted this returns
 * an empty list with table_missing: true so the page can say so instead of
 * looking broken.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();
    const { data, error: qErr } = await db
      .from("missed_call_leads")
      .select("id, caller_phone, caller_name, need, area, urgency, status, step, source, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (qErr) {
      if (isMissingLeadsTable(qErr)) return ok({ leads: [], table_missing: true });
      console.error("[api/admin/call-leads] query failed:", qErr.message);
      return serverError();
    }
    return ok({ leads: data ?? [], table_missing: false });
  } catch (e) {
    console.error("[api/admin/call-leads]", e);
    return serverError();
  }
}
