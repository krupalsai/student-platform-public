import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, badRequest, forbidden, serverError, tooManyRequests } from "@/lib/api-response";
import { audit } from "@/lib/audit";
import { logSystemError } from "@/lib/system-errors";
import { generateSupportBotReply } from "@/lib/services/support-bot";
import { runUnifiedStudentAgent } from "@/lib/unified-agent";
import { HISTORY_TURNS, type ChatTurn } from "@/lib/intent-engine/groq-provider";
import { checkRateLimit } from "@/lib/rate-limit";
import { asMenuTopic } from "@/lib/support-menu";
import { logStudentEvent } from "@/lib/student-events";

// A grounded-answer call (Gemini, falling back to Groq) can take several
// seconds — well within Vercel's default 10s on a good day, but this route
// now always waits on that call before responding, so it gets the same
// headroom every other AI-latency route in this codebase carries.
// 60s: when every cloud AI is down, the self-hosted CPU model (ai-server/)
// can take up to SELF_HOSTED_AI_TIMEOUT_MS (40s) to answer.
export const maxDuration = 60;

/**
 * Inserts the AI's reply as its own `sender: "bot"` row right after the
 * student's message, in the same request — so the client's next GET (or
 * the reply this POST/PUT itself could include, but the frontend already
 * re-fetches after every send) shows both turns together, the way a real
 * chat does. Never throws: a failed bot reply degrades to a plain
 * apology rather than leaving the student's message looking unanswered
 * AND erroring the whole submit.
 *
 * `caption`/`photoDescription` are passed through SEPARATELY, never
 * pre-merged into one string — a photo with no caption is not a question,
 * and `generateSupportBotReply` treats those two cases very differently
 * (see its own comment; a live report showed what happens when they
 * weren't kept separate — the bot hallucinated a full, confident, totally
 * unrelated answer to a bare photo with nothing actually asked).
 */
async function replyAsBot(
  db: ReturnType<typeof createServiceClient>,
  queryId: string,
  studentId: string,
  caption: string,
  photoDescription: string | null | undefined,
  priorHistory: ChatTurn[],
  waitingOnTeam = false,
): Promise<void> {
  let text: string;
  let meta: Record<string, unknown> = {};
  let escalation: { unknownQuestionId: string | null } | null = null;
  // Unified Agent (shared brain): deterministic own-status / FAQ /
  // other-student refusal first, scoped to this session's studentId.
  // Skipped while a case waits on the team, and for photo-only messages.
  // On handled: false the existing grounded-LLM path below runs unchanged.
  let unified: Awaited<ReturnType<typeof runUnifiedStudentAgent>> | null = null;
  if (caption.trim() && !waitingOnTeam) {
    try {
      const r = await runUnifiedStudentAgent(db, { role: "student", profileId: studentId, channel: "app" }, caption);
      if (r.handled) unified = r;
    } catch (e) {
      console.error("[api/support] unified agent failed, falling back:", (e as Error).message);
    }
  }
  try {
    if (unified) {
      text = unified.answer;
      meta = { provider: "unified-agent", source: unified.source };
    } else {
      const result = await generateSupportBotReply(db, studentId, { caption, photoDescription, waitingOnTeam }, priorHistory);
      text = result.reply;
      meta = {
        ...(result.action ? { action: result.action } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.retryable ? { retryable: true } : {}),
        ...(result.escalated ? { escalated: true } : {}),
      };
      if (result.escalated) escalation = { unknownQuestionId: result.unknownQuestionId ?? null };
    }
  } catch (e) {
    console.error("[api/support] bot reply generation failed:", (e as Error).message);
    text = "Sorry, I couldn't process that just now. Please try again in a moment.";
    meta = { retryable: true };
  }
  // What was asked and how it was resolved — so improvements follow real
  // student needs. Typed text is kept (trimmed) only for typed questions.
  const menuTopic = asMenuTopic(caption);
  void logStudentEvent(db, {
    student_id: studentId,
    event_type: "support.asked",
    page: "/support",
    metadata: {
      kind: menuTopic ? "menu" : photoDescription && !caption.trim() ? "photo" : "typed",
      topic: menuTopic ?? null,
      text: menuTopic ? null : caption.trim().slice(0, 200) || null,
      resolved_by: escalation ? "team" : meta.retryable ? "unavailable" : menuTopic ? "menu" : "assistant",
    },
  });

  const { error } = await db.from("student_query_messages").insert({
    query_id: queryId,
    sender: "bot",
    body: text,
    meta: Object.keys(meta).length ? meta : null,
  });
  if (error) {
    console.error("[api/support] bot reply insert failed:", error.message);
    return;
  }
  const nowIso = new Date().toISOString();
  await db.from("student_queries").update({
    last_message_at: nowIso,
    last_sender: "bot",
    // Escalated → the thread is a visible support case until the team replies.
    ...(escalation
      ? { status: "pending_admin", escalated_at: nowIso, unknown_question_id: escalation.unknownQuestionId }
      : {}),
  }).eq("id", queryId);
}

/**
 * Cost guard for TYPED messages (each can mean an AI call, and an escalation
 * means admin time): 10/hour and 25/day per student, plus a platform-wide
 * 600/hour circuit breaker. Menu-button taps (support-menu.ts) are answered
 * from data with no AI and are not counted — the menu is the free path.
 * Uses the fail-OPEN limiter: a rate-limit table hiccup must not block a
 * student from getting help.
 */
async function overLimit(db: ReturnType<typeof createServiceClient>, studentId: string): Promise<string | null> {
  const hour = await checkRateLimit(db, `support:h:${studentId}`, 10, 3600);
  if (!hour.allowed) return "You've typed a lot of messages this hour. Please use the menu (☰) for instant answers, or try again later.";
  const day = await checkRateLimit(db, `support:d:${studentId}`, 25, 86400);
  if (!day.allowed) return "You've reached today's limit for typed messages. The menu (☰) still answers instantly; you can type again tomorrow.";
  const global = await checkRateLimit(db, "support:global:h", 600, 3600);
  if (!global.allowed) return "Support is very busy right now. Please try again in a few minutes.";
  return null;
}

type HistoryRow = { sender: string; body: string; photo_description: string | null; meta?: { escalated?: boolean; retryable?: boolean } | null };

/**
 * True when an earlier assistant reply sent this case to the team and nobody
 * from the team has answered since — so a repeat must not be escalated again.
 */
function isWaitingOnTeam(rows: HistoryRow[]): boolean {
  let waiting = false;
  for (const m of rows) {
    if (m.sender === "bot" && m.meta?.escalated) waiting = true;
    if (m.sender === "admin") waiting = false;
  }
  return waiting;
}

/**
 * Prior turns as model memory. Team replies are included, labelled as such.
 * The assistant's own "I've sent this to the team" and "couldn't reach my
 * service" messages are left out: they carry no facts, and a model shown
 * several of them in a row just repeats them (item #236).
 */
function toHistory(all: HistoryRow[]): ChatTurn[] {
  const rows = all.filter((m) => !(m.sender === "bot" && (m.meta?.escalated || m.meta?.retryable)));
  return rows.slice(-HISTORY_TURNS).map((m) => ({
    role: m.sender === "student" ? "user" : "assistant",
    content: (m.sender === "admin" ? "(Support team reply) " : "")
      + (m.photo_description ? `${m.body}\n(Photo: ${m.photo_description})` : m.body),
  }));
}

const photoFields = {
  // Set by the client only after POST /api/support/image-describe already
  // uploaded the file and ran vision analysis — this route never uploads
  // or analyzes anything itself.
  photoUrl: z.string().url().optional(),
  photoDescription: z.string().max(1000).optional(),
};

const createSchema = z.object({
  message: z.string().trim().max(2000).default(""),
  ...photoFields,
  category: z.enum(["registration", "payment", "documents", "batch", "petition", "technical", "other"]).default("other"),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
}).refine((d) => d.message.length >= 3 || !!d.photoUrl, {
  message: "Please describe the issue or attach a photo",
  path: ["message"],
});

const replySchema = z.object({
  queryId: z.string().uuid(),
  message: z.string().trim().max(2000).default(""),
  ...photoFields,
  /** Regenerate the reply to the student's last message (after an outage) — inserts no new student message. */
  retry: z.boolean().optional(),
}).refine((d) => d.retry || d.message.length >= 1 || !!d.photoUrl, {
  message: "Message is required",
  path: ["message"],
});

export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();
    const queryId = new URL(req.url).searchParams.get("queryId");

    const query = db
      .from("student_queries")
      .select("id, message, category, priority, status, created_at, last_message_at, last_sender, resolved_at, escalated_at, admin_responded_at")
      .eq("student_id", user!.profileId)
      .order("created_at", { ascending: false });

    const { data: threads, error: threadError } = queryId
      ? await query.eq("id", queryId)
      : await query;
    if (threadError) return serverError("Could not load support conversations.");

    const selected = threads ?? [];
    const ids = selected.map((t: any) => t.id);
    const { data: messages, error: msgError } = ids.length
      ? await db.from("student_query_messages").select("id, query_id, sender, body, photo_url, meta, created_at").in("query_id", ids).order("created_at", { ascending: true })
      : { data: [], error: null };
    if (msgError) return serverError("Could not load support messages.");

    return ok({
      threads: selected,
      messages: messages ?? [],
    });
  } catch (e) {
    console.error("Support GET error:", e);
    await logSystemError(createServiceClient(), "api/support:GET", e);
    return serverError();
  }
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  const body = createSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest(body.error.errors[0]?.message ?? "Invalid request");

  try {
    const db = createServiceClient();
    // Menu taps are answered from data (no AI) — they never count against the limit.
    const isMenuTap = !body.data.photoUrl && !!asMenuTopic(body.data.message ?? "");
    const limited = isMenuTap ? null : await overLimit(db, user!.profileId);
    if (limited) return tooManyRequests(limited);
    const { data: profile } = await db
      .from("profiles")
      .select("id, phone, full_name, batch_id, college")
      .eq("id", user!.profileId)
      .maybeSingle();

    const displayBody = body.data.message || "📷 Photo";

    const { data: row, error: insertErr } = await db.from("student_queries").insert({
      student_id: user!.profileId,
      name: profile?.full_name ?? null,
      message: displayBody,
      batch_id: profile?.batch_id ?? null,
      college: profile?.college ?? null,
      last_message_at: new Date().toISOString(),
      last_sender: "student",
      source: "student_app",
      category: body.data.category,
      priority: body.data.priority,
      status: "open",
    }).select("id").single();

    if (insertErr || !row) {
      console.error("Support thread insert failed:", insertErr);
      return serverError("Could not create your support request.");
    }

    const { error: msgInsertErr } = await db.from("student_query_messages").insert({
      query_id: row.id,
      sender: "student",
      author_id: user!.profileId,
      body: displayBody,
      photo_url: body.data.photoUrl ?? null,
      photo_description: body.data.photoDescription ?? null,
    });

    if (msgInsertErr) {
      console.error("Support first-message insert failed:", msgInsertErr);
      return serverError("Could not save your support message.");
    }

    await audit("support.submitted", "student_query", row.id, {
      category: body.data.category,
      priority: body.data.priority,
    }, user!.profileId, "student");

    await replyAsBot(db, row.id, user!.profileId, body.data.message, body.data.photoDescription, []);

    return ok({ id: row.id });
  } catch (e) {
    console.error("Support POST error:", e);
    await logSystemError(createServiceClient(), "api/support:POST", e);
    return serverError();
  }
}

export async function PUT(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  const body = replySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest(body.error.errors[0]?.message ?? "Invalid request");

  try {
    const db = createServiceClient();
    const { data: thread } = await db
      .from("student_queries")
      .select("id, student_id, status")
      .eq("id", body.data.queryId)
      .eq("student_id", user!.profileId)
      .maybeSingle();

    if (!thread) return forbidden();
    // Menu taps are answered from data (no AI) — they never count against the limit.
    const isMenuTap = !body.data.photoUrl && !!asMenuTopic(body.data.message ?? "");
    const limited = isMenuTap ? null : await overLimit(db, user!.profileId);
    if (limited) return tooManyRequests(limited);
    if (thread.status === "resolved") return badRequest("This conversation is closed. Start a new one.");

    // The AI needs the conversation so far to answer follow-ups sensibly
    // (e.g. "which one?" after it already asked a clarifying question) —
    // fetched BEFORE inserting this new message, so it isn't duplicated
    // into its own history. photo_description is folded back in per turn
    // so a photo shared earlier in the thread isn't forgotten once its
    // description scrolls out of the visible bubble.
    const { data: priorRows } = await db
      .from("student_query_messages")
      .select("sender, body, photo_description, meta")
      .eq("query_id", thread.id)
      .order("created_at", { ascending: true });

    if (body.data.retry) {
      const rows = priorRows ?? [];
      let idx = rows.length - 1;
      while (idx >= 0 && rows[idx].sender !== "student") idx--;
      if (idx < 0) return badRequest("Nothing to retry.");
      const last = rows[idx];
      const caption = last.body === "📷 Photo" ? "" : last.body;
      await replyAsBot(db, thread.id, user!.profileId, caption, last.photo_description, toHistory(rows.slice(0, idx)), isWaitingOnTeam(rows.slice(0, idx)));
      return ok({ id: thread.id });
    }

    const priorHistory = toHistory(priorRows ?? []);
    const waitingOnTeam = isWaitingOnTeam(priorRows ?? []);

    const displayBody = body.data.message || "📷 Photo";

    await db.from("student_query_messages").insert({
      query_id: thread.id,
      sender: "student",
      author_id: user!.profileId,
      body: displayBody,
      photo_url: body.data.photoUrl ?? null,
      photo_description: body.data.photoDescription ?? null,
    });

    await db.from("student_queries").update({
      message: displayBody,
      last_message_at: new Date().toISOString(),
      last_sender: "student",
      // A follow-up on a case still waiting for the team keeps it in the
      // team's queue; anything else goes back to the assistant.
      status: thread.status === "pending_admin" ? "pending_admin" : "open",
      resolved_at: null,
    }).eq("id", thread.id);

    await audit("support.reply_submitted", "student_query", thread.id, {}, user!.profileId, "student");

    await replyAsBot(db, thread.id, user!.profileId, body.data.message, body.data.photoDescription, priorHistory, waitingOnTeam);

    return ok({ id: thread.id });
  } catch (e) {
    console.error("Support PUT error:", e);
    await logSystemError(createServiceClient(), "api/support:PUT", e);
    return serverError();
  }
}
