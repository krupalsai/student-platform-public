import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, badRequest, serverError, dbError, tooManyRequests } from "@/lib/api-response";
import { canReadGroupChat, canPostGroupChat } from "@/lib/authz";
import { isGroupChatEnabled } from "@/lib/services/payment-settings";
import { uploadToCloudinary } from "@/lib/storage";
import { checkRateLimit } from "@/lib/rate-limit";
import { notifyStudent } from "@/lib/services/student-notifications";
import { ALLOWED_IMAGE_MIME } from "@/lib/image-types";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const maxDuration = 30;

const MAX_BODY_LEN = 2000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_PHOTO_MIME = ALLOWED_IMAGE_MIME as readonly string[];
const ALLOWED_DOCUMENT_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/zip",
]);
type RouteContext = { params: Promise<{ batchId: string }> };

async function resolveAccess(
  db: ReturnType<typeof createServiceClient>, role: string, profileId: string, batchId: string,
  sessionBatchId: string | null, sessionProfileComplete: boolean,
): Promise<{ isOwnBatch: boolean; senderName: string }> {
  const { data: profile } = await db.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
  const senderName = profile?.full_name ?? "Student";
  const isOwnBatch = sessionProfileComplete === true && sessionBatchId === batchId;
  return { isOwnBatch, senderName };
}

async function addSeenCounts(db: ReturnType<typeof createServiceClient>, messages: any[]) {
  if (!messages.length) return messages;
  const ids = messages.map(m => m.id);
  const { data: reads, error } = await db.from("group_message_reads").select("message_id, reader_id").in("message_id", ids);
  if (error) {
    console.error("[group-chat] read receipt lookup failed", error);
    return messages.map(m => ({ ...m, seen_count: 0 }));
  }
  const counts = new Map<string, number>();
  for (const r of reads ?? []) counts.set(r.message_id, (counts.get(r.message_id) ?? 0) + 1);
  return messages.map(m => ({ ...m, seen_count: counts.get(m.id) ?? 0 }));
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const { batchId } = await ctx.params;
  const db = createServiceClient();
  const { isOwnBatch } = await resolveAccess(db, user!.role, user!.profileId, batchId, user!.batchId, user!.isProfileComplete);
  if (!canReadGroupChat(user!.role, isOwnBatch)) return forbidden();

  const sp = req.nextUrl.searchParams;
  const since = sp.get("since");
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 50, 1), 200);
  let query = db.from("group_messages")
    .select("id, sender_id, sender_name, sender_role, body, photo_url, created_at")
    .eq("batch_id", batchId).is("deleted_at", null);
  if (since) query = query.gt("created_at", since).order("created_at", { ascending: true }).limit(limit);
  else query = query.order("created_at", { ascending: false }).limit(limit);
  const { data, error: err } = await query;
  if (err) return dbError("api/group-chat/[batchId]/messages GET", err);
  const ordered = since ? (data ?? []) : (data ?? []).slice().reverse();
  return ok(await addSeenCounts(db, ordered));
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const { batchId } = await ctx.params;
  const db = createServiceClient();
  const { isOwnBatch, senderName } = await resolveAccess(db, user!.role, user!.profileId, batchId, user!.batchId, user!.isProfileComplete);
  if (!canPostGroupChat(user!.role, isOwnBatch)) return forbidden();

  if (user!.role === "student") {
    if (!(await isGroupChatEnabled(db))) return forbidden();
    const rl = await checkRateLimit(db, `chat_send:${user!.profileId}`, 20, 60);
    if (!rl.allowed) return tooManyRequests("You're sending messages too fast. Please slow down.");
  }

  let form: FormData;
  try { form = await req.formData(); } catch { return badRequest("Write a message or attach a photo/document."); }
  try {
    const rawBody = form.get("body");
    const attachment = form.get("attachment") as File | null;
    const body = typeof rawBody === "string" ? rawBody.trim().slice(0, MAX_BODY_LEN) : "";
    if (!body && !attachment) return badRequest("Write a message or attach a photo/document.");

    let photoUrl: string | null = null;
    let finalBody = body;
    if (attachment) {
      const mime = attachment.type.toLowerCase();
      const isPhoto = ALLOWED_PHOTO_MIME.includes(mime);
      const isDocument = ALLOWED_DOCUMENT_MIME.has(mime);
      if (!isPhoto && !isDocument) return badRequest("File type not supported. Attach a photo, PDF, Word, Excel, PowerPoint, text, CSV, or ZIP file.");
      if (attachment.size > MAX_ATTACHMENT_BYTES) return badRequest("File too large — max 10 MB");
      const buffer = Buffer.from(await attachment.arrayBuffer());
      const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "attachment";
      const filename = `${batchId}/${user!.profileId}_${Date.now()}_${safeName}`;
      const { url } = await uploadToCloudinary("chat", buffer, filename, mime);
      photoUrl = url;
      if (isDocument && !body) finalBody = `[Document] ${attachment.name}`.slice(0, MAX_BODY_LEN);
    }

    const { data, error: err } = await db.from("group_messages").insert({
      batch_id: batchId, sender_id: user!.profileId, sender_name: senderName, sender_role: user!.role,
      body: finalBody || null, photo_url: photoUrl,
    }).select("id, sender_id, sender_name, sender_role, body, photo_url, created_at").single();
    if (err) return dbError("api/group-chat/[batchId]/messages POST", err);

    const { data: members, error: memberError } = await db.from("profiles")
      .select("id").eq("role", "student").eq("batch_id", batchId).neq("id", user!.profileId).not("phone", "is", null);
    if (!memberError && members?.length) {
      const preview = finalBody || "sent an attachment";
      const notification = `${senderName}: ${preview}`.slice(0, 500);
      await Promise.all(members.map(m => notifyStudent(db, m.id, "group_message", notification, data.id, { url: `/dashboard?discussion=${batchId}` })
        .catch(e => console.error("[group-chat] notification failed", m.id, e))));
    } else if (memberError) console.error("[group-chat] member notification lookup failed", memberError);
    return ok({ ...data, seen_count: 0 });
  } catch (e) {
    console.error("[api/group-chat/[batchId]/messages POST]", e);
    return serverError();
  }
}
