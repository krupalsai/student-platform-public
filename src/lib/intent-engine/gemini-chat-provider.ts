/**
 * Gemini — PRIMARY provider for the grounded conversational answer. Groq is
 * only tried when Gemini itself is unavailable (missing/denied key, network
 * error, timeout, bad HTTP status) — see generateGroundedAnswer() in
 * index.ts for the actual ordering. NOT used to override Gemini when Gemini
 * successfully responds but says it doesn't know (ESCALATE) — in that case
 * a human should answer, and a second model guessing from the same limited
 * grounding risks a confident wrong answer instead of the honest "I don't
 * know", which matters most on exactly the legal/court questions this bot
 * has to be careful about.
 *
 * Shares the exact same system prompt, grounding facts, and ESCALATE
 * contract as the Groq path (groq-provider.ts) — only the API call and
 * request/response shape differ, since Gemini's generateContent API isn't
 * OpenAI-compatible like Groq's.
 *
 * Uses EMBEDDINGS_API_KEY/GEMINI_API_KEY — the same key already used for
 * FAQ embeddings (src/lib/embeddings.ts). If that key is invalid, this fails
 * the same way embeddings do: caught, logged,
 * result is "unavailable" — index.ts then falls through to Groq.
 */

import type { StudentContext, ChatTurn, Audience, BotAnswerResult } from "./groq-provider";
import { buildSystemPrompt, buildGroundingBlocks, isEscalateSentinel, HISTORY_TURNS } from "./groq-provider";
import { completeAnswer } from "./answer-text";

// gemini-2.0-flash was retired — confirmed live in prod (404: "This model
// models/gemini-2.0-flash is no longer available. Please update your code
// to use models/gemini-3.6-flash"), Google's own error naming the exact
// replacement. GEMINI_CHAT_MODEL env var still overrides this if it
// changes again before anyone notices.
const DEFAULT_MODEL = "gemini-3.6-flash";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

// 429/503 are transient (rate limit / "high demand") — one retry after a
// short pause recovers most of them instead of dropping straight to the
// next provider on every demand spike. Other statuses are returned as
// "unavailable" immediately; retrying a 400/401/404 is pointless.
const TRANSIENT_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function generateBotAnswerGemini(
  apiKey: string,
  question: string,
  studentCtx: StudentContext = {},
  conversationHistory: ChatTurn[] = [],
  knowledgeBase: { question: string; answer: string }[] = [],
  audience: Audience = "student",
  liberal = false,
  channel: "whatsapp" | "app" = "whatsapp",
): Promise<BotAnswerResult> {
  const { contextBlock, knowledgeBlock } = buildGroundingBlocks(studentCtx, knowledgeBase);
  const systemPrompt = buildSystemPrompt(audience, contextBlock, knowledgeBlock, liberal, channel);
  const model = process.env.GEMINI_CHAT_MODEL ?? DEFAULT_MODEL;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    try {
      const res = await fetch(`${GEMINI_API_URL}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            // Gemini uses "model", not "assistant", for its own turns —
            // everything else about the shape mirrors Groq's message list.
            ...conversationHistory.slice(-HISTORY_TURNS).map(t => ({
              role: t.role === "assistant" ? "model" : "user",
              parts: [{ text: t.content }],
            })),
            { role: "user", parts: [{ text: question }] },
          ],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error(`[gemini-chat] http ${res.status} (model ${model}) attempt ${attempt}/${MAX_ATTEMPTS}`, errText.slice(0, 300));
        if (TRANSIENT_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return { kind: "unavailable" };
      }
      const body = await res.json();
      const candidate = body?.candidates?.[0];
      const text: unknown = candidate?.content?.parts?.[0]?.text;
      if (typeof text !== "string" || !text.trim()) return { kind: "unavailable" };
      if (isEscalateSentinel(text)) return { kind: "escalate" };
      // Never show a reply that was cut off at the token limit (answer-text.ts).
      const finished = completeAnswer(text, candidate?.finishReason === "MAX_TOKENS");
      return finished ? { kind: "answer", text: finished } : { kind: "unavailable" };
    } catch (err) {
      console.error("[gemini-chat] request failed:", (err as Error).message);
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  return { kind: "unavailable" };
}
