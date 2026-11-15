/** Shared Groq vision caller with safe model discovery. */

const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

// Groq deprecates vision models fairly often — every entry below except
// the qwen ones has already been retired at least once (confirmed against
// https://console.groq.com/docs/deprecations, 2026-09-02): the original
// llava/llama-3.2-vision models were migrated to llama-4-scout/maverick,
// which were themselves later migrated to openai/gpt-oss-120b (text-only,
// NOT a vision replacement) or qwen/qwen3.6-27b (the actual vision
// successor). Kept the old names below only so a still-active key on an
// older Groq account tier keeps working; qwen entries are current as of
// this date and listed first so they're preferred when both resolve.
const VISION_CANDIDATES = [
  "qwen/qwen3.6-27b",
  "qwen/qwen3.8-27b",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.2-90b-vision-preview",
  "llama-3.2-11b-vision-preview",
];

let resolvedModel: string | null | undefined;

export async function listGroqModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      console.error("[groq-vision] models list http", res.status, await res.text().catch(() => ""));
      return [];
    }
    const body = await res.json();
    return (body?.data ?? [])
      .map((m: { id?: string }) => m?.id)
      .filter((id: unknown): id is string => typeof id === "string");
  } catch (e) {
    console.error("[groq-vision] models list failed:", (e as Error).message);
    return [];
  }
}

export async function resolveVisionModel(apiKey: string): Promise<string | null> {
  const pinned = process.env.GROQ_VISION_MODEL?.trim();
  if (pinned) return pinned;
  if (resolvedModel !== undefined) return resolvedModel;

  const available = await listGroqModels(apiKey);
  const match = VISION_CANDIDATES.find((c) => available.includes(c))
    ?? available.find((id) => /vision|llava|scout|maverick|qwen3\.\d+-27b/i.test(id));

  resolvedModel = match ?? null;
  if (match) console.log("[groq-vision] using vision model:", match);
  else console.warn("[groq-vision] no vision-capable model available to this key; skipping Groq fallback");
  return resolvedModel;
}

export async function callGroqVision(opts: {
  prompt: string;
  imageUrl: string;
  maxTokens?: number;
  label: string;
}): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;

  const model = await resolveVisionModel(apiKey);
  if (!model) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        // Floored at 900 for the same reason vision.ts floors Gemini's
        // maxOutputTokens: Qwen3 models are
        // hybrid "thinking" models whose internal reasoning draws from this
        // same token budget before the visible JSON answer, so the small
        // per-field budgets id-ocr.ts/payment-ocr.ts pass (250/300) leave
        // nothing for a real reply — confirmed live: qwen/qwen3.6-27b
        // returned `400 json_validate_failed, failed_generation:""` (an
        // entirely empty generation) at max_tokens:250.
        // Capped below Groq's 1000-output-token limit: the old 1024 floor
        // came back as HTTP 429 on the vision call (Nov 2026), so the
        // floor is 900 — still far above the 250 that produced empty
        // generations, and under the limit that rejected the request.
        max_tokens: Math.min(Math.max(opts.maxTokens ?? 300, 900), 900),
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: [
            { type: "text", text: opts.prompt },
            { type: "image_url", image_url: { url: opts.imageUrl } },
          ],
        }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[${opts.label}] groq vision http ${res.status} (model ${model})`, detail);
      if (res.status === 404) resolvedModel = undefined;
      return null;
    }
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text : null;
  } catch (e) {
    console.error(`[${opts.label}] groq vision failed:`, (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
