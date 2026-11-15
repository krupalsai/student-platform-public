import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, notFound, badRequest, serverError, zodError } from "@/lib/api-response";
import { audit } from "@/lib/audit";
import { postTeamReply } from "@/lib/services/support-cases";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

/** GET — one thread with every message (student, assistant, team). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();
  const { id } = await ctx.params;
  try {
    const db = createServiceClient();
    const { data: thread } = await db
      .from("student_queries")
      .select("id, message, status, created_at, escalated_at, admin_responded_at, college, student_id, profiles:student_id(full_name, phone, batches!profiles_batch_id_fkey(name))")
      .eq("id", id).maybeSingle();
    if (!thread) return notFound("Conversation");
    const { data: messages } = await db
      .from("student_query_messages")
      .select("id, sender, body, photo_url, photo_description, meta, created_at")
      .eq("query_id", id)
      .order("created_at", { ascending: true });
    const history = await studentHistory(db, thread.student_id as string | null, id,
      (thread.profiles as { phone?: string | null } | null)?.phone ?? null);
    return ok({ thread, messages: messages ?? [], history });
  } catch (e) {
    console.error("[api/admin/support/[id]] GET", e);
    return serverError();
  }
}

const ReplySchema = z.object({
  message: z.string().trim().max(2000).default(""),
  resolve: z.boolean().optional(),
});

/** POST — reply inside the student's thread (and/or close it). The student is notified. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();
  const { id } = await ctx.params;
  try {
    const body = ReplySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) return zodError(body.error);
    const db = createServiceClient();

    if (!body.data.message) {
      if (!body.data.resolve) return badRequest("Type a reply.");
      const { data, error: upErr } = await db.from("student_queries")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("id", id).select("id");
      if (upErr || !data?.length) return notFound("Conversation");
      await audit("support.resolved", "student_query", id, {}, user!.profileId, user!.role);
      return ok({ resolved: true });
    }

    const result = await postTeamReply(db, id, body.data.message, user!.profileId, { resolve: body.data.resolve });
    if (!result.ok) return notFound("Conversation");
    await audit("support.team_replied", "student_query", id, { resolve: !!body.data.resolve }, user!.profileId, user!.role);
    return ok({ replied: true });
  } catch (e) {
    console.error("[api/admin/support/[id]] POST", e);
    return serverError();
  }
}

type Db = ReturnType<typeof createServiceClient>;

/**
 * Everything else this student has said to us, so the team reads the whole
 * story before replying: their other in-app conversations (both sides), their
 * WhatsApp chat with the bot (the last turns kept in whatsapp_moderation),
 * and the questions they raised that were sent to the team. Each part fails
 * soft — a missing part just shows as empty.
 */
async function studentHistory(db: Db, studentId: string | null, currentId: string, phone: string | null) {
  const ten = (phone ?? "").replace(/\D/g, "").slice(-10);
  const [threads, wa, questions] = await Promise.all([
    studentId
      ? db.from("student_queries")
          .select("id, status, created_at, student_query_messages(sender, body, photo_url, created_at)")
          .eq("student_id", studentId).neq("id", currentId)
          .order("created_at", { ascending: false }).limit(10)
          .then((r) => r.data ?? [], () => [])
      : Promise.resolve([]),
    ten.length === 10
      ? db.from("whatsapp_moderation").select("recent_turns").eq("phone", ten).maybeSingle()
          .then((r) => (r.data?.recent_turns as { r: string; t: string; at?: string }[] | null) ?? [], () => [])
      : Promise.resolve([]),
    ten.length === 10
      ? db.from("unknown_questions")
          .select("id, question, status, occurrence_count, first_seen_at, answered_at")
          .in("student_phone", [ten, `91${ten}`, `+91${ten}`])
          .order("first_seen_at", { ascending: false }).limit(20)
          .then((r) => r.data ?? [], () => [])
      : Promise.resolve([]),
  ]);
  const otherThreads = (threads as { id: string; status: string; created_at: string; student_query_messages: { sender: string; body: string; photo_url: string | null; created_at: string }[] | null }[])
    .map((t) => ({
      id: t.id, status: t.status, created_at: t.created_at,
      messages: [...(t.student_query_messages ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    }));
  const whatsapp = (Array.isArray(wa) ? wa : []).map((x) => ({
    sender: x.r === "u" ? "student" : "bot", body: String(x.t ?? ""), at: x.at ?? null,
  }));
  return { otherThreads, whatsapp, questions };
}
