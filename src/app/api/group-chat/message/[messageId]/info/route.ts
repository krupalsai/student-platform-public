import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, dbError, notFound } from "@/lib/api-response";
import { canReadGroupChat } from "@/lib/authz";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = { params: Promise<{ messageId: string }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const { messageId } = await ctx.params;
  const db = createServiceClient();

  const { data: message, error: messageError } = await db
    .from("group_messages")
    .select("id, batch_id, sender_id, sender_name, sender_role, body, photo_url, created_at")
    .eq("id", messageId)
    .is("deleted_at", null)
    .maybeSingle();
  if (messageError) return dbError("api/group-chat/message/[messageId]/info message lookup", messageError);
  if (!message) return notFound("Message not found.");

  const isOwnBatch = user!.isProfileComplete === true && user!.batchId === message.batch_id;
  if (!canReadGroupChat(user!.role, isOwnBatch)) return forbidden();

  const { data: reads, error: readsError } = await db
    .from("group_message_reads")
    .select("reader_id, seen_at")
    .eq("message_id", messageId)
    .order("seen_at", { ascending: true });
  if (readsError) return dbError("api/group-chat/message/[messageId]/info reads lookup", readsError);

  const readerIds = (reads ?? []).map(r => r.reader_id).filter(Boolean);
  let profiles: { id: string; full_name: string | null }[] = [];
  if (readerIds.length) {
    const { data, error: profileError } = await db.from("profiles").select("id, full_name").in("id", readerIds);
    if (profileError) return dbError("api/group-chat/message/[messageId]/info reader lookup", profileError);
    profiles = data ?? [];
  }
  const names = new Map(profiles.map(p => [p.id, p.full_name || "Unknown"]));
  return ok({
    message,
    readers: (reads ?? []).map(r => ({ name: names.get(r.reader_id) ?? "Unknown", seen_at: r.seen_at })),
  });
}
