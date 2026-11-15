import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, zodError, serverError } from "@/lib/api-response";
import { getAdminSnapshot } from "@/lib/admin-copilot";
import { prepareAction, executeAction, AdminAction } from "@/lib/admin-copilot-agent";
import { assertUnifiedAdminActor, prepareUnifiedAdminAction } from "@/lib/unified-agent";
import { parseAdminActionIntent } from "@/lib/admin-copilot-intent";
import { matchFastRead, runFastRead, getBriefing, renderBriefing, findStudent, getWaitlistDetails, getStudentDocuments } from "@/lib/admin-copilot-data";
import { runAdminAgentLoop, sanitizeAnswer } from "@/lib/admin-copilot-loop";
import { retrieveRelevantFaqs } from "@/lib/services/faq-retrieval";
import { askSelfHostedCopilot } from "@/lib/admin-copilot-selfhosted";
import { loadHistory, saveTurns, clearHistory, resolveFollowUp, MEMORY_TURNS } from "@/lib/admin-copilot-memory";
import { parseRegStatsQuery, getDayStats, getEnrolledStudentTotal, getPlatformTotals, formatDayStats } from "@/lib/admin-stats";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
// The self-hosted CPU model can take up to ~40s; only that last-resort path is slow.
export const maxDuration = 60;

const Schema = z.object({
  question: z.string().trim().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).max(40).optional(),
  pending_token: z.string().max(10000).optional(),
  confirm: z.boolean().optional(),
});

type Actor = { profileId: string; role: string };

/**
 * Shared write path for every recognised action, wherever it came from
 * (deterministic parser, agent loop or legacy planner): role gates first,
 * then the one-tap confirmation token. Nothing executes here.
 */
async function respondWithAction(db: ReturnType<typeof createServiceClient>, action: AdminAction, user: Actor) {
  if (["archive_batch", "delete_student"].includes(action.name) && user.role !== "super_admin") {
    return ok({ answer: "Only Super Admin can perform that destructive action.", action_executed: false });
  }
  // Unified Agent: every admin write, wherever it came from, now passes
  // the shared role gate first, then the existing prepareAction token
  // flow. Nothing executes here — a token is still required to run it.
  const prepared = await prepareUnifiedAdminAction(db, action, { profileId: user.profileId, role: user.role });
  if (prepared.ok && "token" in prepared) return ok({ answer: prepared.confirmation, confirmation_required: true, action_token: prepared.token });
  if (prepared.ok && "message" in prepared && prepared.message) return ok({ answer: prepared.message, action_executed: false });
  return ok({ answer: prepared.message ?? "I could not prepare that action.", action_executed: false });
}

/**
 * GET — the opening briefing the copilot page shows on load, so the admin
 * sees what needs attention before they ask anything.
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error || !user) return forbidden();
  try {
    const db = createServiceClient();
    if (new URL(req.url).searchParams.get("history") === "1") {
      return ok({ history: (await loadHistory(db, user.profileId, 40)) ?? [] });
    }
    const briefing = await getBriefing(db);
    return ok({ briefing: renderBriefing(briefing) });
  } catch (err) {
    console.error("[api/admin/copilot GET]", err);
    return serverError();
  }
}

async function handlePost(req: NextRequest) {
  const startedAt = Date.now();
  const { user, error } = await requireAdmin(req);
  if (error || !user) return forbidden();
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const db = createServiceClient();
    const history = body.data.history ?? [];
    const actor = { profileId: user.profileId, role: user.role };
    // Unified Agent guard, defence in depth behind requireAdmin above.
    const actorGuard = assertUnifiedAdminActor(actor);
    if (actorGuard) return forbidden();

    if (body.data.pending_token && body.data.confirm === true) {
      const result = await executeAction(db, body.data.pending_token, actor);
      return ok({ answer: result.message, action_executed: result.ok });
    }

    // UI/code edits are developer work, never an admin data action. Keep this
    // ahead of the planner so the model cannot mistake a screen control for a
    // student call or ask the admin to describe the page it is already on.
    // "Add college ... code SNIST" contains the words "add" and "code",
    // which the UI-request matcher below would mistake for a screen/code
    // edit. A create-college command is a data action, never a UI edit.
    const isAddCollege = /\b(?:create|add)\s+(?:a\s+)?(?:new\s+)?(?:college|colleges|collage)\b/i.test(body.data.question);
    const uiRequest = !isAddCollege && (/\b(?:remove|hide|move|fix|change|add|show|redesign|update|edit)\b.{0,100}\b(?:button|call option|phone icon|screen|layout|interface|ui|code|textbox|text box|input box|menu|color|font)\b/i.test(body.data.question)
      || /\b(?:ui|code|layout|screen|interface)\b.{0,100}\b(?:change|fix|remove|hide|add|update|edit)\b/i.test(body.data.question));
    if (uiRequest) {
      const floatingCall = /\b(?:call option|call button|phone button|phone icon)\b/i.test(body.data.question);
      const { error: logError } = await db.from("audit_logs").insert({
        actor_id: actor.profileId, actor_role: actor.role,
        action: "copilot.ui_change_request", target_type: "developer_request",
        target_id: null,
        meta: { page: "/admin/copilot", request: body.data.question, floating_call_button: floatingCall },
      });
      if (logError) console.error("[api/admin/copilot] UI request log failed", logError);
      const detail = floatingCall ? "I understand you mean the floating phone button on this Copilot screen. " : "";
      return ok({ answer: detail + "I can't change the app's UI or code from this chat. " +
        (logError ? "I couldn't log the request for the developer, so please report it directly." : "I've logged your request for the developer to review."), action_executed: false });
    }

    // Contextual waitlist follow-up. Phrases such as "Details of their" refer
    // to the students in the immediately preceding waitlist result, not to a
    // student literally named "their".
    const waitlistFollowUp = /\bdetails?\s+(?:of|for)\s+(?:their|those|these)\b/i.test(body.data.question)
      && history.some(h => h.role === "assistant" && /wait[- ]list|waitlist|waiting students/i.test(h.content));
    if (waitlistFollowUp) {
      return ok({ answer: await getWaitlistDetails(db), action_executed: false });
    }

    // 1. The deterministic parser for high-value operational commands.
    // This prevents a temporary LLM formatting/model failure from turning a
    // real admin command into a read-only chatbot response.
    const deterministic = parseAdminActionIntent(body.data.question);
    if (deterministic) return respondWithAction(db, deterministic, actor);

    // 1b. Registration/stats questions are answered deterministically
    // from live counts — the same shared stats module the WhatsApp bot
    // uses (lib/admin-stats) — never left to the LLM chain. The chain's
    // free-tier providers can all degrade at once, which used to bury
    // the day's count inside the fallback snapshot wall; a question that
    // names a day now LEADS with that day's number.
    const statsQuery = parseRegStatsQuery(body.data.question);
    if (statsQuery) {
      if (statsQuery.day === "total") {
        const totals = await getPlatformTotals(db);
        return ok({
          answer:
            `Students (enrolled): ${totals.students}\n` +
            `Pending payments: ${totals.pendingPayments}\n` +
            `Approved payments: ${totals.approvedPayments}\n` +
            `Active batches: ${totals.activeBatches}`,
          action_executed: false,
        });
      }
      const [dayStats, enrolled] = await Promise.all([getDayStats(db, statsQuery.day), getEnrolledStudentTotal(db)]);
      return ok({ answer: formatDayStats(statsQuery.day, dayStats, enrolled, false), action_executed: false });
    }

    // Student searches should not depend on a model or its free-tier quota.
    // Keep this read-only path narrow so operational commands still go through
    // the planner and its confirmation flow.
    const question = resolveFollowUp(body.data.question.trim(), history);
    const roll = question.match(/\b\d{2}[a-z0-9]{8}\b/i)?.[0];
    // Numbers are often typed or pasted with spaces/dashes in the middle
    // ("+91 9876543201"); close those gaps before looking for a phone.
    const compact = question.replace(/(?<=\d)[ -](?=\d)/g, "");
    const phone = compact.match(/(?<!\d)(?:\+?91)?[6-9]\d{9}(?!\d)/)?.[0];
    // A message that is nothing but a phone number or roll number is a lookup.
    const bareIdentifier = /^\s*(?:\+?[\d][\d\s-]{8,16}|\d{2}[a-z0-9]{8})\s*$/i.test(question);
    const named = question.match(/\b(?:find|look\s*up|search(?:\s+for)?|show|who\s+is|details?\s+(?:for|of)|status\s+(?:for|of))\s+(?:me\s+)?(?:the\s+)?(?:student\s+)?(?:named?\s+)?(?!their\b|those\b|these\b|them\b)([a-z][a-z.' -]{2,50}?)(?:\s*(?:\?|[.,]|\b(?:with|roll|phone|number|in\s+batch)\b)|$)/i)?.[1]?.trim();
    const surname = question.match(/\bsurname\s*(?::|is|of)?\s*([a-z][a-z'-]{2,40})\b/i)?.[1];
    const isStudentRead = (bareIdentifier || /\b(?:find|look\s*up|search|show|who\s+is|details?|status|student|surname|roll\s*(?:no|number)?)\b/i.test(question))
      && !/\b(?:edit|delete|verify|message|send|remind|approve|reject|update|change|remove)\b/i.test(question);
    // A generic operational phrase ("show pending payments") is not a name.
    const genericRead = /\b(?:payments?|batches?|fees?|waitlist|questions?|documents?|petition|signature|certificate|summary|overview|attention)\b/i.test(question);
    const studentQuery = isStudentRead ? roll ?? phone ?? surname ?? (genericRead ? null : named) : null;
    if (studentQuery && /\b(?:documents?|petition|college\s*id|id\s*card|signature|certificate)\b/i.test(question)) {
      const rows = await getStudentDocuments(db, studentQuery);
      return ok({ answer: rows.length ? rows.map(r =>
        `• ${r.student} | Roll: ${r.roll ?? "not recorded"} | ID uploaded: ${r.college_id_uploaded ? "yes" : "no"} | Automated signature check: ${r.signature_check == null ? "not recorded" : r.signature_check ? "present" : "missing"} | Petition: ${r.petition?.status ?? "not recorded"}`
      ).join("\n") + "\nThis does not confirm certificate delivery or a legal outcome." : `No student found for "${studentQuery}".`, action_executed: false });
    }
    if (studentQuery) {
      const matches = await findStudent(db, studentQuery);
      if (!matches.length) return ok({ answer: `No student found for "${studentQuery}". Check the spelling or roll number.`, action_executed: false });
      const lines = matches.map(student => {
        const payment = student.latest_payment
          ? `${student.latest_payment.status} (₹${student.latest_payment.amount.toLocaleString("en-IN")})`
          : "none recorded";
        return `• ${student.name} | Roll: ${student.roll ?? "not recorded"} | ${student.batch ?? student.college ?? "no batch"} | Payment: ${payment}`;
      });
      return ok({ answer: lines.join("\n"), action_executed: false });
    }

    // 2. Unambiguous read-only phrases get instant, LLM-free answers.
    const fastRead = matchFastRead(body.data.question);
    if (fastRead) return ok({ answer: await runFastRead(db, fastRead), action_executed: false });

    // 3. The agent loop: the model plans, calls read-only tools over live
    // app data, chains them for multi-step jobs, and proposes writes through
    // propose_action — which lands in the same confirmation flow as (1).
    const loop = await runAdminAgentLoop(db, body.data.question, actor, history);
    if (loop?.action) return respondWithAction(db, loop.action, actor);
    // Last server-side gate: raw tool-protocol blocks never leave the API.
    if (loop?.answer) return ok({ answer: sanitizeAnswer(loop.answer) || "I couldn't get that right now — please try again.", action_executed: false });

    // 4. Honest deterministic snapshot when every AI provider is unavailable.
    // Do not repeat provider calls after the bounded tool loop has failed.
    // Operational commands still use the deterministic confirmed path above.
    // A create-college command that reaches this far was not understood by
    // the parser (e.g. no name was given): never let it degrade into a
    // stats snapshot — say plainly it cannot be created from here.
    if (/\b(?:create|add)\b.{0,60}\b(?:college|colleges|collage)\b/i.test(question)) {
      return ok({ answer: "I can't create a college right now — the AI service is busy. Add it from the Colleges page (Admin → Colleges → Add college), or tell me the college name again in a moment.", action_executed: false });
    }
    const snapshot = await getAdminSnapshot(db);
    {
      const p = snapshot.payments;
      const fallback = `The AI service is busy. I can still look up students by name or roll number, and show batch and payment summaries. Here is the current snapshot:\n\n` +
        `• Students: ${snapshot.students.total} enrolled\n` +
        `• Pending payments: ${p.submitted ?? 0}\n` +
        `• Approved: ${p.approved ?? 0} · Total collected: ₹${snapshot.totalCollected.toLocaleString("en-IN")}\n` +
        `• Today: ${snapshot.today.registrations} registrations, ${snapshot.today.approvedPayments} payments (₹${snapshot.today.collected.toLocaleString("en-IN")})\n` +
        `• Active batches: ${snapshot.batches.filter(b => b.status === "active").map(b => `${b.name} (${b.enrolled})`).join(", ") || "none"}`;
      // 4b. Self-hosted model (Oracle VM) — answers in plain language from the
      // same snapshot when configured; otherwise the snapshot itself is shown.
      // The agent loop already spent up to 24s, so cap this last-resort call
      // to what is left of the 60s function limit — otherwise Vercel kills
      // the reply mid-sentence and the chat shows a network error.
      const selfHostedBudgetMs = Math.max(5000, 50000 - (Date.now() - startedAt));
      const faqCtx = await retrieveRelevantFaqs(createServiceClient(), question, history)
        .then(r => r.faqs.slice(0, 3).map(f => `Q: ${f.question}\nA: ${f.answer.slice(0, 500)}`).join("\n\n"))
        .catch(() => "");
      const selfHosted = await askSelfHostedCopilot(question, history, fallback, selfHostedBudgetMs, faqCtx);
      if (selfHosted) return ok({ answer: sanitizeAnswer(selfHosted) || selfHosted, degraded: true, action_executed: false });
      return ok({ answer: fallback, degraded: true });
    }
  } catch (err) {
    console.error("[api/admin/copilot]", err);
    if (err instanceof Error && /Could not read/.test(err.message)) {
      return ok({ answer: "I couldn't verify the live data right now. Please try again; I won't guess student records or totals.", degraded: true, action_executed: false });
    }
    return serverError();
  }
}

/**
 * Memory wrapper: the server, not the browser, owns the conversation. It
 * loads this admin's stored history (so context survives reloads and works
 * across the Copilot page), hands it to the same handler
 * as before, then stores the exchange.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error || !user) return forbidden();
  let raw: { question?: unknown; history?: unknown; pending_token?: unknown; confirm?: unknown } | null = null;
  try { raw = await req.json(); } catch { return zodError(new z.ZodError([{ code: "custom", path: [], message: "Invalid JSON" }])); }
  const db = createServiceClient();
  // Conversation memory is best-effort: a slow or failing history read must
  // never delay or break the answer — fall back to what the browser sent.
  let stored: Awaited<ReturnType<typeof loadHistory>> = null;
  try {
    stored = await Promise.race([
      loadHistory(db, user.profileId, MEMORY_TURNS),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
    ]);
  } catch (e) {
    console.error("[api/admin/copilot] history load skipped", (e as Error)?.message ?? e);
    stored = null;
  }
  const merged = { ...(raw ?? {}), history: stored ?? (Array.isArray(raw?.history) ? raw!.history : []) };
  const inner = new NextRequest(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(merged) });
  const res = await handlePost(inner);
  // Save the exchange without making the admin wait for it: the old code
  // awaited the save before returning, so a slow insert delayed every reply.
  // Failures are logged with the real error so a broken store is visible.
  try {
    const j = await res.clone().json();
    const answer = j?.success ? j.data?.answer : null;
    const question = typeof raw?.question === "string" ? raw.question.trim() : "";
    if (question && typeof answer === "string" && answer) {
      void saveTurns(db, user.profileId, [{ role: "user", content: question }, { role: "assistant", content: answer }])
        .catch(e => console.error("[api/admin/copilot] memory save failed", (e as Error)?.message ?? e));
    }
  } catch (e) { console.error("[api/admin/copilot] memory save skipped", e); }
  return res;
}

export async function DELETE(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error || !user) return forbidden();
  await clearHistory(createServiceClient(), user.profileId);
  return ok({ cleared: true });
}
