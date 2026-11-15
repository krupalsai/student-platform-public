/**
 * Cloudflare Workers AI vision caller for the College-ID / payment image
 * checks. Free tier (10,000 Neurons/day). Uses the same env vars as the
 * WhatsApp bot's Cloudflare provider (src/lib/intent-engine/cloudflare-provider.ts):
 * CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN — no new credentials, no new
 * accounts. Pin a different model with CLOUDFLARE_VISION_MODEL.
 *
 * Model: @cf/qwen/qwen3.8-27b — verified live 2026-11-09 with a real
 * ID-card image and the real id-ocr prompt: accepts image_url content and
 * returns the JSON extraction (is_id_card / has_signature / notes).
 * ~50 Neurons per check. No license agreement needed.
 *
 * Do NOT switch to a Meta vision model (@cf/meta/llama-3.2-11b-vision-instruct
 * etc.) without Krupal first agreeing to Meta's community license in the
 * Cloudflare dashboard — the API 403s until the account accepts it
 * ("Model Agreement: submit the prompt 'agree'"). @cf/qwen/qwen2-vl-7b-instruct
 * does not exist (400 "No route for that URI").
 */

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_VISION_MODEL = "@cf/qwen/qwen3.8-27b";

function cloudflareVisionConfig(): { accountId: string; token: string } | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.replace(/\s+/g, "");
  const token = process.env.CLOUDFLARE_AI_TOKEN?.replace(/\s+/g, "");
  if (!accountId || !token) return null;
  return { accountId, token };
}

async function fetchImageAsBase64(imageUrl: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buf.toString("base64") };
  } catch (e) {
    console.error("[cloudflare-vision] failed to fetch image:", (e as Error).message);
    return null;
  }
}

export async function callCloudflareVision(opts: {
  prompt: string;
  imageUrl: string;
  maxTokens?: number;
  label: string;
}): Promise<string | null> {
  const cfg = cloudflareVisionConfig();
  if (!cfg) return null;

  const image = await fetchImageAsBase64(opts.imageUrl);
  if (!image) return null;

  const model = process.env.CLOUDFLARE_VISION_MODEL?.trim() || DEFAULT_VISION_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${CLOUDFLARE_API_BASE}/${cfg.accountId}/ai/run/${model}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: opts.prompt },
              { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } },
            ],
          },
        ],
        temperature: 0,
        // Qwen3 is a hybrid "thinking" model whose internal reasoning draws
        // from the same token budget — same floor logic as groq-vision.ts
        // (900): small per-field budgets leave nothing for a real reply.
        max_tokens: Math.max(opts.maxTokens ?? 300, 900),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[${opts.label}] cloudflare vision http ${res.status} (model ${model})`, detail.slice(0, 300));
      return null;
    }
    const body = await res.json();
    // Workers AI answers either natively ({ result: { response } }) or in
    // the OpenAI chat-completions envelope ({ result: { choices[0].message.content } }).
    const text =
      body?.result?.response ??
      body?.result?.choices?.[0]?.message?.content ??
      null;
    if (typeof text === "string" && text.trim()) return text;
    console.error(`[${opts.label}] cloudflare vision empty response (model ${model})`);
    return null;
  } catch (e) {
    console.error(`[${opts.label}] cloudflare vision failed:`, (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
