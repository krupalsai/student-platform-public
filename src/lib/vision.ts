/**
 * Shared vision caller for College-ID and payment image checks.
 * Cloudflare is primary (free tier, @cf/qwen/qwen3.8-27b, verified live);
 * Gemini second (free-key pool); Groq third when a vision model is actually
 * available to the configured Groq key. No single provider is required —
 * each returns null when unavailable and the chain falls through.
 */

import { callCloudflareVision } from "./cloudflare-vision";
import { callGroqVision } from "./groq-vision";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_VISION_MODELS = [
  "gemini-3.6-flash",
];

/**
 * Free-tier quota is per API key, so pool several free keys and rotate when
 * one hits its daily limit — no billing needed. Extra keys: generate free
 * ones at AI Studio (aistudio.google.com → Get API key; each new Google
 * Cloud project gets its own free quota) and set GEMINI_API_KEY_2, _3, …
 * in Vercel. EMBEDDINGS_API_KEY stays first for backward compatibility.
 */
function getGeminiKeys(): string[] {
  const raw = [
    process.env.EMBEDDINGS_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
  ];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const k of raw) {
    const t = (k ?? "").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      keys.push(t);
    }
  }
  return keys;
}

// key → epoch ms when the key may be tried again. A key that returns a
// quota/rate-limit error is parked until the next UTC midnight, when free
// quotas reset. Module-level so warm serverless instances share it.
const keyQuarantinedUntil = new Map<string, number>();

function isKeyAvailable(key: string): boolean {
  return (keyQuarantinedUntil.get(key) ?? 0) <= Date.now();
}

function quarantineKey(label: string, key: string): void {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0); // next UTC midnight — free quota reset
  keyQuarantinedUntil.set(key, d.getTime());
  console.warn(`[${label}] gemini key …${key.slice(-4)} hit quota; parked until UTC midnight`);
}

function isQuotaError(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  const t = bodyText.toLowerCase();
  return (
    t.includes("quota") ||
    t.includes("resource_exhausted") ||
    t.includes("rate limit") ||
    t.includes("rate_limit")
  );
}

// Successful results are cached per label+image URL for an hour. The checks
// are advisory and deterministic (temperature 0), so re-checking the same
// image — e.g. admin batch re-verify — must not burn quota twice.
const visionCache = new Map<string, { text: string; expires: number }>();
const VISION_CACHE_TTL_MS = 60 * 60 * 1000;

function cacheGet(label: string, imageUrl: string): string | null {
  const hit = visionCache.get(`${label}:${imageUrl}`);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    visionCache.delete(`${label}:${imageUrl}`);
    return null;
  }
  return hit.text;
}

function cacheSet(label: string, imageUrl: string, text: string): void {
  if (visionCache.size > 500) {
    const oldest = visionCache.keys().next();
    if (!oldest.done) visionCache.delete(oldest.value);
  }
  visionCache.set(`${label}:${imageUrl}`, { text, expires: Date.now() + VISION_CACHE_TTL_MS });
}

async function fetchImageAsBase64(imageUrl: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buf.toString("base64") };
  } catch (e) {
    console.error("[vision] failed to fetch image for gemini:", (e as Error).message);
    return null;
  }
}

async function callGeminiVisionModel(opts: {
  apiKey: string;
  prompt: string;
  image: { mimeType: string; data: string };
  maxTokens?: number;
  label: string;
  model: string;
}): Promise<{ text: string | null; quotaExceeded: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${GEMINI_API_URL}/${opts.model}:generateContent?key=${encodeURIComponent(opts.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: opts.prompt },
            { inlineData: { mimeType: opts.image.mimeType, data: opts.image.data } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: Math.max(opts.maxTokens ?? 300, 1024),
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      const quotaExceeded = isQuotaError(res.status, bodyText);
      console.error(`[${opts.label}] gemini vision http ${res.status} (model ${opts.model})`, bodyText.slice(0, 300));
      return { text: null, quotaExceeded };
    }

    const body = await res.json();
    const parts = body?.candidates?.[0]?.content?.parts;
    const text: string = Array.isArray(parts)
      ? parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";
    const finishReason = body?.candidates?.[0]?.finishReason;
    console.log(`[${opts.label}] gemini vision model=${opts.model} finishReason=${finishReason} textLen=${text.length}`);
    if (!text.trim()) return { text: null, quotaExceeded: false };
    return { text, quotaExceeded: false };
  } catch (e) {
    console.error(`[${opts.label}] gemini vision failed (model ${opts.model}):`, (e as Error).message);
    return { text: null, quotaExceeded: false };
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiVision(opts: {
  prompt: string;
  imageUrl: string;
  maxTokens?: number;
  label: string;
}): Promise<string | null> {
  const image = await fetchImageAsBase64(opts.imageUrl);
  if (!image) return null;

  const keys = getGeminiKeys();
  if (!keys.length) return null;

  const configured = process.env.GEMINI_VISION_MODEL?.trim();
  const models = Array.from(new Set([
    ...(configured ? [configured] : []),
    ...DEFAULT_GEMINI_VISION_MODELS,
  ]));

  for (const key of keys) {
    if (!isKeyAvailable(key)) continue;
    for (const model of models) {
      const result = await callGeminiVisionModel({ ...opts, image, model, apiKey: key });
      if (result.text) return result.text;
      if (result.quotaExceeded) {
        quarantineKey(opts.label, key);
        break; // this key is done for today — try the next one
      }
      // Non-quota failure: try the next model on the same key.
    }
  }
  return null;
}

export async function callVision(opts: {
  prompt: string;
  imageUrl: string;
  maxTokens?: number;
  label: string;
}): Promise<string | null> {
  const cached = cacheGet(opts.label, opts.imageUrl);
  if (cached) return cached;

  const cloudflareResult = await callCloudflareVision(opts);
  const geminiResult = cloudflareResult ?? (await callGeminiVision(opts));
  const result = geminiResult ?? (await callGroqVision(opts));
  if (result) cacheSet(opts.label, opts.imageUrl, result);
  return result;
}

/** Parse JSON even when a vision provider wraps it in markdown or extra text. */
export function parseVisionJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter((s): s is string => !!s);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch { /* try next */ }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("no JSON object found in vision response");
}
