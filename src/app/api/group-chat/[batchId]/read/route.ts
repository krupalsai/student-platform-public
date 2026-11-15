import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, badRequest, dbError } from "@/lib/api-response";
import { canReadGroupChat } from "@/lib/authz";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = { params: Promise<{ batchId: string }> };

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const { batchId } = await ctx.params;
  const db = createServiceClient();
  const isOwnBatch = user!.isProfileComplete === true && user!.batchId === batchId;
  if (!canReadGroupChat(user!.role, isOwnBatch)) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch { return badRequest("Invalid read receipt payload."); }
  const ids = Array.isArray((body as any)?.messageIds) ? (body as any).messageIds.filter((id: unknown) => typeof id === "string").slice(0, 200) : [];
  if (!ids.length) return ok({ marked: 0 });

  const { data: validMessages, error: messageError } = await db
    .from("group_messages").select("id").eq("batch_id", batchId).in("id", ids);
  if (messageError) return dbError("api/group-chat/[batchId]/read message lookup", messageError);

  const rows = (validMessages ?? []).map(m => ({ message_id: m.id, reader_id: user!.profileId }));
  const { error: upsertError } = await db.from("group_message_reads").upsert(rows, { onConflict: "message_id,reader_id", ignoreDuplicates: true });
  if (upsertError) return dbError("api/group-chat/[batchId]/read upsert", upsertError);
  return ok({ marked: rows.length });
}
