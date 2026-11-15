/**
 * Text embeddings for semantic FAQ search.
 *
 * Groq (the platform's chat/vision provider) has no embeddings API, so this
 * uses Google's free text-embedding-004 (768-dim). It's the one place Gemini
 * is still used, and only for embeddings — chat/vision stay on Groq.
 *
 * Everything degrades gracefully: embedText() returns null if no key is
 * configured or the call fails, and searchFaq() then falls back to its
 * existing trigram/keyword matching. So semantic search is a strict upgrade
 * when an embedding key is present and a no-op (no regression) when it isn't.
 *
 * Config:
 *   EMBEDDINGS_API_KEY  (or GEMINI_API_KEY) — required to enable embeddings
 *   EMBEDDINGS_MODEL    — default "text-embedding-004"
 */

/**
 * Model candidates, tried in order until one works.
 *
 * "text-embedding-004" was the original default but Google retired it — it now
 * returns 404 ("models/text-embedding-004 is not found for API version v1beta"),
 * which was firing on every embedding call in production. "gemini-embedding-001"
 * is the current model; it defaults to 3072 dims but accepts outputDimensionality
 * so we can keep the 768 that faqs.embedding vector(768) requires. The retired
 * model is kept as a fallback so a key that still serves it keeps working.
 *
 * Set EMBEDDINGS_MODEL to pin one explicitly and skip probing.
 */
const MODEL_CANDIDATES = ["gemini-embedding-001", "text-embedding-004"];
export const EMBEDDING_DIM = 768; // must match faqs.embedding vector(768)

/** Remembers which candidate worked, so we probe once per instance, not per call. */
let resolvedModel: string | null = null;

function apiKey(): string | null {
  // Trimmed defensively — a copy-pasted key with a trailing newline/space is
  // exactly the class of bug this project already hit once with
  // WHATSAPP_APP_SECRET (bug #39 class), and an untrimmed key would fail
  // here with a confusing 403/400 instead of an obvious "not configured".
  const key = (process.env.EMBEDDINGS_API_KEY || process.env.GEMINI_API_KEY || "").trim();
  return key || null;
}

/** True when an embedding provider is configured (used to skip work early). */
export function embeddingsEnabled(): boolean {
  return !!apiKey();
}

/**
 * Returns a 768-dim embedding for `text`, or null if embeddings are
 * unconfigured/unavailable or the call fails. Never throws.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const key = apiKey();
  const clean = (text ?? "").trim();
  if (!key || !clean) return null;

  // Pinned model wins; otherwise use the one we already proved works, else probe.
  const pinned = process.env.EMBEDDINGS_MODEL;
  const candidates = pinned ? [pinned] : resolvedModel ? [resolvedModel] : MODEL_CANDIDATES;

  for (const model of candidates) {
    const values = await embedWithModel(model, key, clean);
    if (values) {
      if (!pinned) resolvedModel = model; // remember the winner
      return values;
    }
  }
  return null;
}

/** One attempt against a specific model. Returns null on any failure. */
async function embedWithModel(model: string, key: string, clean: string): Promise<number[] | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text: clean.slice(0, 4000) }] },
        // Newer models default to 3072 dims; ask for the 768 the column needs.
        // Models that always return 768 ignore this field.
        ...(model === "text-embedding-004" ? {} : { outputDimensionality: EMBEDDING_DIM }),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[embeddings] http ${res.status} (model ${model})`, await res.text().catch(() => ""));
      return null;
    }
    const body = await res.json();
    const values = body?.embedding?.values;
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIM) {
      console.error(`[embeddings] unexpected shape from ${model} (len:`, values?.length, ")");
      return null;
    }
    return values as number[];
  } catch (e) {
    console.error(`[embeddings] failed (model ${model}):`, (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
