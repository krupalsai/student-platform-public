/**
 * Self-hosted open-source model (ai-server/ — Ollama in Docker on an Oracle
 * Always Free VM, fronted by Caddy with a bearer token). Same system prompt,
 * grounding facts and ESCALATE contract as every other provider; Ollama
 * speaks the OpenAI chat format, so only the endpoint differs.
 *
 * Inert unless SELF_HOSTED_AI_URL and SELF_HOSTED_AI_TOKEN are both set.
 *
 * CPU-only hardware is slow (roughly 10-40 s per answer), so by default this
 * is the LAST resort — it answers only when Gemini, Groq and OpenRouter are
 * all unavailable. SELF_HOSTED_AI_ROLE=primary tries it first instead
 * (WhatsApp included), bounded by SELF_HOSTED_AI_TIMEOUT_MS: a timeout
 * reports "unavailable" and the cloud chain answers, so the webhook never
 * waits on a slow CPU model (see generateGroundedAnswerDetailed in index.ts).
 */

import type { StudentContext, ChatTurn, Audience, BotAnswerResult } from "./groq-provider";
import { buildSystemPrompt, buildGroundingBlocks, isEscalateSentinel, HISTORY_TURNS } from "./groq-provider";
import { completeAnswer } from "./answer-text";

export function selfHostedConfig(): { url: string; token: string; model: string; timeoutMs: number; primary: boolean } | null {
  const url = (process.env.SELF_HOSTED_AI_URL ?? "").trim().replace(/\/$/, "");
  const token = (process.env.SELF_HOSTED_AI_TOKEN ?? "").trim();
  if (!url || !token) return null;
  return {
    url,
    token,
    model: (process.env.SELF_HOSTED_AI_MODEL ?? "qwen2.5:3b").trim(),
    timeoutMs: Number(process.env.SELF_HOSTED_AI_TIMEOUT_MS ?? 40000),
    primary: (process.env.SELF_HOSTED_AI_ROLE ?? "").trim().toLowerCase() === "primary",
  };
}

export async function generateBotAnswerSelfHosted(
  cfg: NonNullable<ReturnType<typeof selfHostedConfig>>,
  question: string,
  studentCtx: StudentContext = {},
  conversationHistory: ChatTurn[] = [],
  knowledgeBase: { question: string; answer: string }[] = [],
  audience: Audience = "student",
  channel: "whatsapp" | "app" = "app",
): Promise<BotAnswerResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const { contextBlock, knowledgeBlock } = buildGroundingBlocks(studentCtx, knowledgeBase);
  const systemPrompt = buildSystemPrompt(audience, contextBlock, knowledgeBlock, false, channel);

  try {
    const res = await fetch(`${cfg.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.token}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt },
          ...conversationHistory.slice(-HISTORY_TURNS).map(t => ({ role: t.role, content: t.content })),
          { role: "user", content: question },
        ],
        temperature: 0.3,
        max_tokens: 300,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[self-hosted-ai] http ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return { kind: "unavailable" };
    }
    const body = await res.json();
    const choice = body?.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) return { kind: "unavailable" };
    if (isEscalateSentinel(text)) return { kind: "escalate" };
    // Never show a reply that was cut off at the token limit (answer-text.ts).
    const finished = completeAnswer(text, choice?.finish_reason === "length");
    return finished ? { kind: "answer", text: finished } : { kind: "unavailable" };
  } catch (err) {
    console.error("[self-hosted-ai] request failed:", (err as Error).message);
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
