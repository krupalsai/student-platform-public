import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, badRequest, notFound, serverError } from "@/lib/api-response";
import { LEAD_STATUSES, isMissingLeadsTable } from "@/lib/whatsapp/missed-call-leads";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/admin/call-leads/[id] — move a missed-call lead along the
 * pipeline (New / Contacted / In progress / Completed / Lost).
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id } = await ctx.params;

  let status = "";
  try {
    const body = await req.json();
    status = String(body?.status ?? "");
  } catch {
    return badRequest("JSON body with status is required.");
  }
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
    return badRequest(`status must be one of: ${LEAD_STATUSES.join(", ")}`);
  }

  try {
    const db = createServiceClient();
    const { data, error: upErr } = await db
      .from("missed_call_leads")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id");
    if (upErr) {
      if (isMissingLeadsTable(upErr)) return badRequest("missed_call_leads table missing — run the migration");
      console.error("[api/admin/call-leads/:id] update failed:", upErr.message);
      return serverError();
    }
    if (!data?.length) return notFound("Lead");
    return ok({ updated: true });
  } catch (e) {
    console.error("[api/admin/call-leads/:id]", e);
    return serverError();
  }
}
