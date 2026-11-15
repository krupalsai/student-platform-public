import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/session";
import { forbidden, badRequest } from "@/lib/api-response";
import { planAdminRequest } from "@/lib/admin-copilot-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type AgEvent = Record<string, unknown>;
function sse(event: AgEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Authenticated AG-UI planning endpoint for the Admin Copilot.
 *
 * SECURITY: never trust forwardedProps.role (client-controlled). The role
 * and actor identity are loaded from the validated server session. This
 * endpoint only plans and streams a proposed action; execution must go
 * through /api/admin/copilot, which re-checks permissions and requires
 * confirmation for writes.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error || !user) return forbidden();

  const input = await req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return badRequest("Invalid request body.");
  }

  const rawMessages = (input as Record<string, unknown>).messages;
  if (!Array.isArray(rawMessages) || rawMessages.length > 40) {
    return badRequest("Messages must be an array of at most 40 turns.");
  }

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of rawMessages) {
    if (!item || typeof item !== "object") return badRequest("Invalid message.");
    const m = item as Record<string, unknown>;
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.content.length > 4000) {
      return badRequest("Each message needs a valid role and content up to 4000 characters.");
    }
    messages.push({ role: m.role, content: m.content });
  }

  const query = [...messages].reverse().find((m) => m.role === "user")?.content.trim() ?? "";
  if (!query || query.length > 2000) return badRequest("A user question of 1–2000 characters is required.");

  const supplied = input as Record<string, unknown>;
  const threadId = typeof supplied.threadId === "string" && supplied.threadId.length <= 100 ? supplied.threadId : randomUUID();
  const runId = typeof supplied.runId === "string" && supplied.runId.length <= 100 ? supplied.runId : randomUUID();
  const role = user.role; // Never accept a role supplied by the browser.
  const safeHistory = messages.map(({ role, content }) => ({ role, content }));

  const stream = new ReadableStream({
    async start(controller) {
      const push = (event: AgEvent) => controller.enqueue(new TextEncoder().encode(sse(event)));
      try {
        push({ type: "RUN_STARTED", threadId, runId });
        push({ type: "STEP_STARTED", stepName: "plan" });
        const msgId = randomUUID();
        push({ type: "TEXT_MESSAGE_START", messageId: msgId, role: "assistant" });

        const action = await planAdminRequest(query, role, safeHistory);
        if (!action) {
          const answer = "I couldn't plan an action for that. Try rephrasing.";
          push({ type: "TEXT_MESSAGE_CONTENT", messageId: msgId, delta: answer });
          push({ type: "TEXT_MESSAGE_END", messageId: msgId });
        } else {
          const summary = `Proposed action: ${action.name}. Review and confirm it in the Admin Copilot before execution.`;
          push({ type: "TEXT_MESSAGE_CONTENT", messageId: msgId, delta: summary });
          push({ type: "TEXT_MESSAGE_END", messageId: msgId });
          const tcId = randomUUID();
          push({ type: "TOOL_CALL_START", toolCallId: tcId, toolCallName: action.name, parentMessageId: msgId });
          push({ type: "TOOL_CALL_ARGS", toolCallId: tcId, delta: JSON.stringify(action) });
          push({ type: "TOOL_CALL_END", toolCallId: tcId });
        }
        push({ type: "STEP_FINISHED", stepName: "plan" });
        push({ type: "RUN_FINISHED", threadId, runId });
      } catch {
        // Never stream provider exception messages, which may include internal details.
        push({ type: "RUN_ERROR", message: "The agent could not complete planning. Please retry." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
