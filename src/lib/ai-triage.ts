import { SupabaseClient } from "@supabase/supabase-js";

/**
 * AI triage provider chain.
 *
 * Triage runs on FREE tiers only, ordered by what is proven to work in
 * production today (the same keys that power the bot's grounded-answer
 * chain in src/lib/intent-engine). Measured 2026-10-20 against the live
 * health-check: OpenRouter answered 3/3 triage runs in ~5s; Cloudflare
 * Workers AI 404'd on a malformed account ID (see triageWithCloudflare)
 * and then exceeded a 12s timeout twice — so OpenRouter leads and
 * Cloudflare, given a longer 30s budget, is the second chance:
 *
 *   1. OpenRouter             (OPENROUTER_API_KEY)
 *   2. Cloudflare Workers AI  (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN)
 *   3. Groq                   (GROQ_API_KEY)
 *   4. Claude                 (ANTHROPIC_API_KEY — only if a key is ever
 *      configured; still gated by the self-tracked monthly budget below)
 *   5. Gemini                 (EMBEDDINGS_API_KEY / GEMINI_API_KEY — last:
 *      the current key has been failing with API 403s since 2026-10-17,
 *      kept in the chain so it rejoins automatically if the key is fixed)
 *
 * The first provider that returns a parseable triage result wins; every
 * attempt's token usage is logged to `ai_usage_ledger`. If every provider
 * fails, triage returns null and the health-check route holds the errors
 * unreported for a later run instead of dumping raw errors on the admins.
 *
 * Claude budget note: Anthropic's API has no ongoing free tier and no
 * endpoint to query remaining trial credit — it's a one-time ~$5 trial,
 * then pay-per-token (see docs.claude.com). So "use Claude until the free
 * tier runs out" is implemented as a SELF-TRACKED budget: every Claude
 * call's token usage is logged with an estimated cost, and once the
 * current calendar month's Claude spend hits ANTHROPIC_MONTHLY_BUDGET_USD
 * (default $5, matching the typical trial credit), Claude is skipped for
 * the rest of the month.
 */

const CLOUDFLARE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_CHAT_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(/\/$/, "");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// Mirrors src/lib/intent-engine/groq-provider.ts — llama-3.3-70b-versatile
// was retired on Groq; gpt-oss-120b is the current default there.
const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
// $1 / $5 per million input/output tokens — Haiku 4.5 pricing as of the
// time this was written. If Anthropic repricing makes this drift, it only
// affects budget tracking accuracy, not correctness of the handoff logic.
const CLAUDE_INPUT_USD_PER_MTOK = 1;
const CLAUDE_OUTPUT_USD_PER_MTOK = 5;

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_CHAT_MODEL ?? "gemini-3.6-flash";

export interface ErrorGroup {
  route: string;
  message: string;
  occurrences: number;
  sample_ids: string[];
  first_seen: string;
  last_seen: string;
}

export interface TriageGroupResult {
  route: string;
  message: string;
  severity: "low" | "medium" | "high" | "critical";
  likely_cause: string;
  confident_fix: boolean;
  suggested_diff: string | null;
}

export type TriageEngine = "cloudflare" | "openrouter" | "groq" | "claude" | "gemini";

export interface TriageResult {
  summary: string;
  groups: TriageGroupResult[];
  engine: TriageEngine;
}

type TriageAttempt = { result: TriageResult; inputTokens: number; outputTokens: number };

function buildPrompt(groups: ErrorGroup[]): string {
  return (
    `You are a production incident triage assistant for "Student Platform", a Next.js + Supabase + ` +
    `Vercel app handling student registration and fee payments for engineering colleges. You are ` +
    `given a batch of deduplicated server errors. For EACH group, assess severity and likely cause. ` +
    `ONLY set confident_fix=true and provide suggested_diff if the bug is small, mechanical, and you ` +
    `are highly confident of the exact fix (e.g. a null check, a wrong property name, a missing await) ` +
    `— do NOT guess at fixes for anything involving business logic, external API contracts, or data ` +
    `you can't see. When unsure, confident_fix=false and suggested_diff=null; a wrong guess reported ` +
    `as confident is worse than an honest "needs a human look".\n\n` +
    `Return ONLY a JSON object matching this shape, no markdown, no prose:\n` +
    `{ "summary": "<2-3 sentence overview across all groups>", "groups": [ ` +
    `{ "route": "...", "message": "...", "severity": "low|medium|high|critical", ` +
    `"likely_cause": "<1-2 sentences>", "confident_fix": <bool>, "suggested_diff": <unified diff string or null> } ] }\n\n` +
    `Errors:\n${JSON.stringify(groups, null, 2)}`
  );
}

/**
 * Parse a provider's raw text into a TriageResult. Tolerant of markdown
 * fences and surrounding prose (the OpenAI-compatible free models don't
 * always honour "JSON only"), and reconciles the parsed groups back onto
 * the input groups — matched by route+message, falling back to position —
 * so the health-check route's per-group lookup always finds an entry and
 * a group is never silently dropped or misattributed.
 */
function parseTriageResponse(text: string, groups: ErrorGroup[], engine: TriageEngine): TriageResult | null {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.groups)) return null;

  const byKey = new Map<string, any>();
  for (const g of parsed.groups) {
    if (g && typeof g.route === "string" && typeof g.message === "string") {
      byKey.set(`${g.route}::${g.message}`, g);
    }
  }
  const severities = ["low", "medium", "high", "critical"];
  const reconciled: TriageGroupResult[] = groups.map((g, i) => {
    const p = byKey.get(`${g.route}::${g.message}`) ?? parsed.groups[i] ?? {};
    return {
      route: g.route,
      message: g.message,
      severity: severities.includes(p.severity) ? p.severity : "medium",
      likely_cause:
        typeof p.likely_cause === "string" && p.likely_cause.trim()
          ? p.likely_cause
          : "Triage engine returned no cause assessment for this group.",
      confident_fix: p.confident_fix === true,
      suggested_diff:
        p.confident_fix === true && typeof p.suggested_diff === "string" ? p.suggested_diff : null,
    };
  });

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    groups: reconciled,
    engine,
  };
}

async function getMonthlyClaudeSpendUsd(db: SupabaseClient): Promise<number> {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const { data } = await db
    .from("ai_usage_ledger")
    .select("estimated_cost_usd")
    .eq("provider", "anthropic")
    .gte("created_at", startOfMonth.toISOString());
  return (data ?? []).reduce((sum, r) => sum + Number(r.estimated_cost_usd ?? 0), 0);
}

async function logUsage(
  db: SupabaseClient,
  provider: TriageEngine,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const estimated_cost_usd =
    provider === "claude"
      ? (inputTokens / 1_000_000) * CLAUDE_INPUT_USD_PER_MTOK + (outputTokens / 1_000_000) * CLAUDE_OUTPUT_USD_PER_MTOK
      : 0; // Free tiers — no cost tracking needed
  await db.from("ai_usage_ledger").insert({
    provider: provider === "claude" ? "anthropic" : provider,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd,
  }).then(undefined, () => {}); // best-effort, never block triage on a logging failure
}

async function triageWithCloudflare(groups: ErrorGroup[]): Promise<TriageAttempt | null> {
  // Strip ALL whitespace, not just the ends: the production
  // CLOUDFLARE_ACCOUNT_ID value carries an embedded space from when it
  // was pasted into Vercel, which made every Workers AI call 404
  // (observed in runtime logs 2026-10-20). Account IDs and API tokens
  // never contain legitimate whitespace, so this is always safe.
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.replace(/\s+/g, "");
  const token = process.env.CLOUDFLARE_AI_TOKEN?.replace(/\s+/g, "");
  if (!accountId || !token) {
    console.warn("health-check: Cloudflare env not configured — trying next triage provider");
    return null;
  }

  try {
    const controller = new AbortController();
    // 30s, not the 12s the chat providers use: Workers AI's 70B model
    // exceeded 12s on a full triage prompt in production (2026-10-20).
    // The health-check is a cron call, so a slow first fallback is fine.
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: buildPrompt(groups) }],
          temperature: 0,
          max_tokens: 2000,
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`health-check: Cloudflare HTTP ${res.status} — trying next triage provider. ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return null;
    }
    const body = await res.json();
    const text = body?.result?.response;
    if (typeof text !== "string") {
      console.warn(
        `health-check: Cloudflare response had no string result.response (got ${typeof text}) — trying next provider. Body head: ${JSON.stringify(body)?.slice(0, 300)}`
      );
      return null;
    }
    const result = parseTriageResponse(text, groups, "cloudflare");
    if (!result) {
      console.warn("health-check: Cloudflare returned unparseable triage output — trying next provider");
      return null;
    }
    return {
      result,
      inputTokens: body?.result?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.result?.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    console.warn("health-check: Cloudflare triage call failed — trying next provider", e);
    return null;
  }
}

async function triageWithOpenAiCompatible(
  provider: "openrouter" | "groq",
  url: string,
  apiKey: string,
  model: string,
  extraHeaders: Record<string, string>,
  groups: ErrorGroup[]
): Promise<TriageAttempt | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: buildPrompt(groups) }],
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`health-check: ${provider} HTTP ${res.status} — trying next triage provider. ${(await res.text().catch(() => "")).slice(0, 300)}`);
      return null;
    }
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return null;
    const result = parseTriageResponse(text, groups, provider);
    if (!result) {
      console.warn(`health-check: ${provider} returned unparseable triage output — trying next provider`);
      return null;
    }
    return {
      result,
      inputTokens: body?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    console.warn(`health-check: ${provider} triage call failed — trying next provider`, e);
    return null;
  }
}

function triageWithOpenRouter(groups: ErrorGroup[]): Promise<TriageAttempt | null> {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) return Promise.resolve(null);
  return triageWithOpenAiCompatible("openrouter", OPENROUTER_API_URL, apiKey, OPENROUTER_MODEL, {
    "HTTP-Referer": APP_URL,
    "X-Title": "Student Platform Health Check",
  }, groups);
}

function triageWithGroq(groups: ErrorGroup[]): Promise<TriageAttempt | null> {
  const apiKey = (process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) return Promise.resolve(null);
  return triageWithOpenAiCompatible("groq", GROQ_API_URL, apiKey, GROQ_MODEL, {}, groups);
}

async function triageWithClaude(groups: ErrorGroup[]): Promise<TriageAttempt | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: buildPrompt(groups) }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      // Insufficient credit, invalid key, rate limited, overloaded — all
      // fall straight through to the next provider. Not fatal to the run.
      console.warn(`health-check: Claude HTTP ${res.status} — falling back. ${errBody.slice(0, 300)}`);
      return null;
    }

    const body = await res.json();
    const text = body?.content?.find((b: any) => b.type === "text")?.text;
    if (typeof text !== "string") return null;
    const result = parseTriageResponse(text, groups, "claude");
    if (!result) return null;
    return {
      result,
      inputTokens: body?.usage?.input_tokens ?? 0,
      outputTokens: body?.usage?.output_tokens ?? 0,
    };
  } catch (e) {
    console.warn("health-check: Claude call failed — falling back", e);
    return null;
  }
}

async function triageWithGemini(groups: ErrorGroup[]): Promise<TriageAttempt | null> {
  const apiKey = (process.env.EMBEDDINGS_API_KEY || process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    console.warn("health-check: EMBEDDINGS_API_KEY/GEMINI_API_KEY not set — no triage engine available this run");
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(groups) }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2000, responseMimeType: "application/json" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.error(`health-check: Gemini HTTP ${res.status} (model ${GEMINI_MODEL})`, await res.text().catch(() => ""));
      return null;
    }
    const body = await res.json();
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return null;
    const result = parseTriageResponse(text, groups, "gemini");
    if (!result) return null;
    return {
      result,
      inputTokens: body?.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: body?.usageMetadata?.candidatesTokenCount ?? 0,
    };
  } catch (e) {
    console.error("health-check: Gemini triage failed", e);
    return null;
  }
}

/**
 * Runs triage down the provider chain (see header): OpenRouter →
 * Cloudflare → Groq → Claude (budget-gated, only if configured) →
 * Gemini. The first successful, parseable result wins and its usage is
 * logged. Returns null only when every provider is unavailable, in
 * which case the caller holds the errors for a later run.
 */
export async function triage(db: SupabaseClient, groups: ErrorGroup[]): Promise<TriageResult | null> {
  const attempts: Array<() => Promise<TriageAttempt | null>> = [
    () => triageWithOpenRouter(groups),
    () => triageWithCloudflare(groups),
    () => triageWithGroq(groups),
  ];

  // Claude stays behind its self-tracked budget gate and is attempted
  // only when a key is actually configured.
  const budgetUsd = Number(process.env.ANTHROPIC_MONTHLY_BUDGET_USD ?? 5);
  const spentUsd = await getMonthlyClaudeSpendUsd(db);
  if (process.env.ANTHROPIC_API_KEY && spentUsd < budgetUsd) {
    attempts.push(() => triageWithClaude(groups));
  }
  attempts.push(() => triageWithGemini(groups));

  for (const attempt of attempts) {
    const res = await attempt();
    if (res) {
      await logUsage(db, res.result.engine, res.inputTokens, res.outputTokens);
      return res.result;
    }
  }

  return null;
}
