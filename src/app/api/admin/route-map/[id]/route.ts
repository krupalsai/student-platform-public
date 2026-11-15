import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, notFound, dbError } from "@/lib/api-response";

/** Removes a Route Map attachment. `params` is a Promise under Next 15 (bug #34). */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  const { id } = await ctx.params;
  const db = createServiceClient();

  const { data, error: err } = await db
    .from("route_map_attachments")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (err) return dbError("api/admin/route-map/[id]", err);
  if (!data) return notFound("Attachment");
  return ok({ id });
}
