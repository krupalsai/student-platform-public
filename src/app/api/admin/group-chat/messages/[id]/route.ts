import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, notFound, dbError } from "@/lib/api-response";
import { audit } from "@/lib/audit";

type RouteContext = { params: Promise<{ id: string }> };

// requireAdmin, which is super_admin-only now like the rest of the console.
// (It was chosen over requireSuperAdmin originally because removing one chat
// message is WhatsApp-group-style moderation rather than item #64's
// protect-student-data-from-a-wipe rule — that distinction only matters again
// if plain `admin` is ever given console access back.) Soft delete (deleted_at),
// same convention as every other moderated record in this app — the message
// stays recoverable, only hidden from group_messages GET's `.is("deleted_at",
// null)` filter.
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id } = await ctx.params;
  const db = createServiceClient();

  const { data, error: err } = await db
    .from("group_messages")
    .update({ deleted_at: new Date().toISOString(), deleted_by: user!.profileId })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id, batch_id")
    .maybeSingle();

  if (err) return dbError("api/admin/group-chat/messages/[id]", err);
  if (!data) return notFound("Message");

  await audit("group_message.deleted", "group_message", id, { batch_id: data.batch_id }, user!.profileId, user!.role);
  return ok({ deleted: true });
}
