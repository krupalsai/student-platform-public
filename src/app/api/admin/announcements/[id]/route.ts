import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError, dbError } from "@/lib/api-response";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  // Deletion is super_admin-only — see students/[id]/route.ts's DELETE
  // for the same reasoning.
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();
  try {
    const { id } = await ctx.params;
    const db = createServiceClient();
    const { error: err } = await db.from("announcements").delete().eq("id", id);
    if (err) return dbError("api/admin/announcements/[id]", err);
    return ok({ deleted: true });
  } catch (err) { console.error("[api/admin/announcements/[id]]", err); return serverError(); }
}
