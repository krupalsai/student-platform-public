/**
 * OpenRouter — THIRD fallback for the grounded conversational answer, after
 * Gemini (primary) and Groq. Same system prompt, grounding facts, and
 * ESCALATE contract as the other two providers (groq-provider.ts) — only
 * the endpoint, headers, and model differ, since OpenRouter's API is
 * OpenAI-compatible like Groq's.
 *
 * Uses OPENROUTER_API_KEY, which is already configured in Vercel but was
 * previously unused on the bot answer path. Model is overridable with
 * OPENROUTER_CHAT_MODEL; the default is a stable, widely-available
 * instruction model deliberately different from the Gemini/Groq families
 * so one provider's outage doesn't take down the fallback too.
 */

import type { StudentContext, ChatTurn, Audience, BotAnswerResult } from "./groq-provider";
import { buildSystemPrompt, buildGroundingBlocks, isEscalateSentinel, HISTORY_TURNS } from "./groq-provider";
import { completeAnswer } from "./answer-text";

const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct";
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(/\/$/, "");

export async function generateBotAnswerOpenRouter(
  apiKey: string,
  question: string,
  studentCtx: StudentContext = {},
  conversationHistory: ChatTurn[] = [],
  knowledgeBase: { question: string; answer: string }[] = [],
  audience: Audience = "student",
  liberal = false,
  channel: "whatsapp" | "app" = "whatsapp",
): Promise<BotAnswerResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  const { contextBlock, knowledgeBlock } = buildGroundingBlocks(studentCtx, knowledgeBase);
  const systemPrompt = buildSystemPrompt(audience, contextBlock, knowledgeBlock, liberal, channel);

  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": APP_URL,
        "X-Title": "Student Platform WhatsApp Bot",
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_CHAT_MODEL ?? DEFAULT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          // Real prior turns, correctly tagged by speaker — this is what gives
          // the assistant genuine multi-turn memory. Bounded to the last 6.
          ...conversationHistory.slice(-HISTORY_TURNS).map(t => ({ role: t.role, content: t.content })),
          { role: "user", content: question },
        ],
        temperature: 0.4,
        // 600, matching Groq's CHAT_MAX_TOKENS (Gemini uses 1024): the old
        // 300-token cap cut longer grounded replies off mid-sentence
        // (finish_reason "length"), and completeAnswer below could only trim
        // the cut reply back — the tail, usually the next step, was lost.
        max_tokens: 600,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[openrouter-chat] http ${res.status}`, (await res.text().catch(() => "")).slice(0, 300));
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
    console.error("[openrouter-chat] request failed:", (err as Error).message);
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
