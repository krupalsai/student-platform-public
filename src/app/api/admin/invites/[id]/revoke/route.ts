import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, notFound, dbError } from "@/lib/api-response";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id } = await ctx.params;
  const db = createServiceClient();
  const { data, error: upErr } = await db
    .from("admin_invites")
    .update({ revoked: true })
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (upErr) return dbError("api/admin/invites/[id]/revoke", upErr, "Failed to revoke invite. Please try again.");
  if (!data) return notFound("Invite");

  return ok({ revoked: true });
}
