/**
 * Entry point for the rest of the app. Business logic should only ever
 * import `getIntentClassifier` from here — never a specific provider
 * directly, and never read provider env vars themselves.
 *
 * Provider is selected by which env var is set:
 *   GROQ_API_KEY   → GroqIntentClassifier   (current default)
 *   Neither        → NullIntentClassifier   (no-op, always UNKNOWN)
 *
 * This is what makes the provider optional and swappable: absent key →
 * NullClassifier, zero network calls, same interface contract.
 */
import type { IntentClassifier, IntentResult, ClassifyContext } from "./types";
import { UNKNOWN_RESULT } from "./types";
import { GroqIntentClassifier } from "./groq-provider";
import { generateBotAnswer, type StudentContext, type ChatTurn, type Audience } from "./groq-provider";
import { isStallPromise } from "./stall-guard";

export type {
  Intent,
  IntentResult,
  ClassifyContext,
  IntentClassifier,
} from "./types";
export { UNKNOWN_RESULT, CONFIDENCE_THRESHOLD } from "./types";
export type { StudentContext, ChatTurn, Audience } from "./groq-provider";

class NullIntentClassifier implements IntentClassifier {
  readonly providerName = "none";
  async classify(): Promise<IntentResult> {
    return UNKNOWN_RESULT;
  }
}

let cached: IntentClassifier | undefined;

/** Returns the configured classifier, or a no-op one if unconfigured.
 *  Safe to call on every message — cheap, synchronous-feeling, never throws. */
export function getIntentClassifier(): IntentClassifier {
  if (cached) return cached;

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      cached = new GroqIntentClassifier(groqKey);
      return cached;
    } catch (err) {
      console.error("Failed to construct GroqIntentClassifier — falling back:", (err as Error).message);
      cached = new NullIntentClassifier();
      return cached;
    }
  }

  console.warn("GROQ_API_KEY not set — intent classification disabled, falling back to non-AI workflow only");
  cached = new NullIntentClassifier();
  return cached;
}

/**
 * Attempts a retrieval-grounded answer using Gemini (primary) + the FAQ
 * corpus + known student profile fields. Returns null if every provider
 * still can't answer after the retries below — callers should escalate to
 * a human in that case, exactly as they did before this existed. Never
 * throws.
 *
 * Provider order: Gemini → Groq → OpenRouter. A provider is only skipped
 * when IT is unavailable — missing/denied key, network error, timeout, bad
 * HTTP status — never when it successfully answered "I don't know" (ESCALATE)
 * even after the retry. Asking a DIFFERENT model to guess from the same
 * limited grounding on a question the primary already declined twice is a
 * different risk than retrying the same model once, which is why a later
 * provider is still never used to second-guess an escalate.
 *
 * Escalate → one retry, same provider, before giving up. A strict first
 * pass that escalates gets ONE more attempt with permission to give
 * general, non-factual guidance (see the `liberal` prompt variant in
 * groq-provider.ts's buildSystemPrompt) — added because pinging the admin
 * on WhatsApp for every one-off vague question was noisy for things a
 * capable model can genuinely help with in general terms. The retry still
 * cannot invent a specific fact (fee, date, policy) and still must
 * escalate anything legal/court/timeline-related — that carve-out is
 * unchanged and verified by test-liberal-retry.ts. If the retry ALSO
 * escalates, this returns null exactly as before.
 *
 * Gemini now retries once internally on transient 429/503 ("high demand")
 * before reporting "unavailable" — see gemini-chat-provider.ts. If Gemini
 * is fully down, Groq (GROQ_API_KEY) answers; if Groq is down too,
 * OpenRouter (OPENROUTER_API_KEY, already configured in Vercel) answers as
 * the last resort, getting the same strict→liberal retry itself.
 */
export type GroundedOutcome =
  | { kind: "answer"; text: string; provider: "cloudflare" | "gemini" | "groq" | "openrouter" | "self-hosted" }
  | { kind: "escalate" }
  | { kind: "unavailable" };

/**
 * A grounded "answer" that only promises to check something is no answer:
 * the bot has one shot at the reply and can never "check later", so a
 * promise-to-check is a dead end (live failure 2026-10-26: "Let me check
 * her records."). Convert it to escalate, so the caller falls through to
 * its honest path (admin → HELP, student → escalation to a human) instead
 * of sending the promise.
 */
function withoutStall(outcome: GroundedOutcome): GroundedOutcome {
  if (outcome.kind === "answer" && isStallPromise(outcome.text)) {
    console.warn("[bot-ai] stall promise filtered — treating as escalate");
    return { kind: "escalate" };
  }
  return outcome;
}

/**
 * Same as generateGroundedAnswer, but tells the caller WHY there is no
 * answer: "escalate" (a provider answered and genuinely didn't know — a
 * human should take it) vs "unavailable" (every configured provider was
 * down). The in-app assistant needs this distinction: an outage must NOT
 * file a support case for a question the AI could answer five minutes later.
 */
export async function generateGroundedAnswerDetailed(
  question: string,
  studentCtx: StudentContext = {},
  conversationHistory: ChatTurn[] = [],
  knowledgeBase: { question: string; answer: string }[] = [],
  audience: Audience = "student",
  channel: "whatsapp" | "app" = "whatsapp",
): Promise<GroundedOutcome> {
  // LangChain + LangGraph RAG chain, IN this platform (src/lib/intent-engine/
  // langchain-rag.ts): retrieve the best FAQ entries, then let the LLM answer
  // from them — and from its own knowledge when the question is outside the
  // FAQ. Tried FIRST so the bot thinks instead of only matching rules. Any
  // failure returns null and the provider chain below takes over, so a
  // broken LangChain install can never silence the bot.
  try {
    const { generateLangChainRagAnswer } = await import("./langchain-rag");
    const ragAnswer = await generateLangChainRagAnswer(
      question,
      audience === "admin" ? "admin" : "student",
    );
    if (ragAnswer) {
      console.info("[bot-ai] provider", { provider: "langchain-rag", outcome: "answer" });
      return { kind: "answer", text: ragAnswer, provider: "groq" };
    }
  } catch (err) {
    console.error("[bot-ai] langchain-rag failed, falling back:", (err as Error).message);
  }

  // The self-hosted open-source model (Ollama on the Oracle ARM VM) serves
  // both channels when SELF_HOSTED_AI_URL/TOKEN are set. Last resort by
  // default; first if SELF_HOSTED_AI_ROLE=primary. As primary for WhatsApp
  // it is bounded by SELF_HOSTED_AI_TIMEOUT_MS — a timeout reports
  // "unavailable" and the cloud chain answers instead, so the webhook
  // never waits on a slow CPU model.
  const { selfHostedConfig, generateBotAnswerSelfHosted } = await import("./self-hosted-provider");
  const selfHosted = selfHostedConfig();
  const trySelfHosted = async (): Promise<GroundedOutcome> => {
    const r = await generateBotAnswerSelfHosted(selfHosted!, question, studentCtx, conversationHistory, knowledgeBase, audience, channel);
    console.info("[bot-ai] provider", { provider: "self-hosted", outcome: r.kind });
    return r.kind === "answer" ? { kind: "answer", text: r.text, provider: "self-hosted" } : { kind: r.kind };
  };

  if (selfHosted?.primary) {
    const first = await trySelfHosted();
    if (first.kind !== "unavailable") return withoutStall(first);
  }
  const cloud = await cloudGroundedAnswer(question, studentCtx, conversationHistory, knowledgeBase, audience, channel);
  if (cloud.kind === "unavailable" && selfHosted && !selfHosted.primary) return withoutStall(await trySelfHosted());
  return withoutStall(cloud);
}

/** Gemini → Groq → OpenRouter, each with a strict→liberal retry on ESCALATE. */
async function cloudGroundedAnswer(
  question: string,
  studentCtx: StudentContext,
  conversationHistory: ChatTurn[],
  knowledgeBase: { question: string; answer: string }[],
  audience: Audience,
  channel: "whatsapp" | "app",
): Promise<GroundedOutcome> {
  const geminiKey = (process.env.EMBEDDINGS_API_KEY || process.env.GEMINI_API_KEY || "").trim();
  if (geminiKey) { // Re-enabled: Cloudflare 404, need fallback
    try {
      // Cloudflare Workers AI — primary 24/7 provider (free tier, edge network).
  // Tries first; falls back to Gemini → Groq → OpenRouter if unavailable.
  try {
    const { cloudflareConfig, generateBotAnswerCloudflare } = await import("./cloudflare-provider");
    if (cloudflareConfig()) {
      const result = await generateBotAnswerCloudflare(question, studentCtx, conversationHistory, knowledgeBase, audience, channel);
      if (result.kind === "answer") {
        console.info("[bot-ai] provider", { provider: "cloudflare", outcome: "answer" });
        return { kind: "answer", text: result.text, provider: "cloudflare" };
      }
      console.warn("[bot-ai] provider", { provider: "cloudflare", outcome: result.kind });
    }
  } catch (e) {
    console.warn("[bot-ai] provider", { provider: "cloudflare", outcome: "error", error: String(e).slice(0, 100) });
  }

  const { generateBotAnswerGemini } = await import("./gemini-chat-provider");
      const result = await generateBotAnswerGemini(geminiKey, question, studentCtx, conversationHistory, knowledgeBase, audience, false, channel);
      if (result.kind === "answer") { console.info("[bot-ai] provider", { provider: "gemini", outcome: "answer" }); return { kind: "answer", text: result.text, provider: "gemini" }; }
      if (result.kind === "escalate") {
        const retry = await generateBotAnswerGemini(geminiKey, question, studentCtx, conversationHistory, knowledgeBase, audience, true, channel);
        console.info("[bot-ai] provider", { provider: "gemini", outcome: retry.kind === "answer" ? "retry_answer" : retry.kind });
        return retry.kind === "answer" ? { kind: "answer", text: retry.text, provider: "gemini" } : { kind: "escalate" };
      }
      console.warn("[bot-ai] provider", { provider: "gemini", outcome: "unavailable" });
      // kind === "unavailable" falls through to the Groq fallback below.
    } catch (err) {
      console.error("generateGroundedAnswer (gemini) failed:", (err as Error).message);
    }
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const result = await generateBotAnswer(groqKey, question, studentCtx, conversationHistory, knowledgeBase, audience, false, channel);
      if (result.kind === "answer") { console.info("[bot-ai] provider", { provider: "groq", outcome: "answer" }); return { kind: "answer", text: result.text, provider: "groq" }; }
      if (result.kind === "escalate") {
        const retry = await generateBotAnswer(groqKey, question, studentCtx, conversationHistory, knowledgeBase, audience, true, channel);
        console.info("[bot-ai] provider", { provider: "groq", outcome: retry.kind === "answer" ? "retry_answer" : retry.kind });
        return retry.kind === "answer" ? { kind: "answer", text: retry.text, provider: "groq" } : { kind: "escalate" };
      }
      console.warn("[bot-ai] provider", { provider: "groq", outcome: "unavailable" });
    } catch (err) {
      console.error("generateGroundedAnswer (groq fallback) failed:", (err as Error).message);
    }
  }

  // Last resort: OpenRouter — a third, independently-operated provider so one
  // outage (e.g. Gemini "high demand" 503s) can't silence the bot.
  const openrouterKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!openrouterKey) return { kind: "unavailable" };
  try {
    const { generateBotAnswerOpenRouter } = await import("./openrouter-provider");
    const result = await generateBotAnswerOpenRouter(openrouterKey, question, studentCtx, conversationHistory, knowledgeBase, audience, false, channel);
    if (result.kind === "answer") { console.info("[bot-ai] provider", { provider: "openrouter", outcome: "answer" }); return { kind: "answer", text: result.text, provider: "openrouter" }; }
    if (result.kind === "escalate") {
      const retry = await generateBotAnswerOpenRouter(openrouterKey, question, studentCtx, conversationHistory, knowledgeBase, audience, true, channel);
      console.info("[bot-ai] provider", { provider: "openrouter", outcome: retry.kind === "answer" ? "retry_answer" : retry.kind });
      return retry.kind === "answer" ? { kind: "answer", text: retry.text, provider: "openrouter" } : { kind: "escalate" };
    }
    console.warn("[bot-ai] provider", { provider: "openrouter", outcome: "unavailable" });
    return { kind: "unavailable" };
  } catch (err) {
    console.error("generateGroundedAnswer (openrouter fallback) failed:", (err as Error).message);
    return { kind: "unavailable" };
  }
}

/** Unchanged contract for existing callers (WhatsApp, voice, copilot):
 *  the answer text, or null for both "escalate" and "all providers down". */
export async function generateGroundedAnswer(
  question: string,
  studentCtx: StudentContext = {},
  conversationHistory: ChatTurn[] = [],
  knowledgeBase: { question: string; answer: string }[] = [],
  audience: Audience = "student",
  channel: "whatsapp" | "app" = "whatsapp",
): Promise<string | null> {
  const r = await generateGroundedAnswerDetailed(question, studentCtx, conversationHistory, knowledgeBase, audience, channel);
  return r.kind === "answer" ? r.text : null;
}
