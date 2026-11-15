/**
 * Verifies callVision() (src/lib/vision.ts) tries Gemini first and only
 * falls back to Groq when Gemini itself is unavailable (no key, image fetch
 * failure, bad HTTP status, empty response). Used by payment-ocr.ts and
 * id-ocr.ts so both OCR-assist features share one fallback policy.
 *
 * Run with: npx tsx scripts/test-vision-fallback.ts
 *
 * Keys are NEVER hardcoded in this file — it is committed to git. Dummy
 * values are enough because every fetch call below is mocked; set real env
 * vars only if you extend this script to hit live APIs.
 */
import assert from "node:assert/strict";

if (!process.env.GROQ_API_KEY) process.env.GROQ_API_KEY = "test-groq-key";
if (!process.env.EMBEDDINGS_API_KEY) process.env.EMBEDDINGS_API_KEY = "test-gemini-key";
process.env.GROQ_VISION_MODEL = "dummy-vision-model"; // pin to skip model discovery

const IMAGE_URL = "https://res.cloudinary.com/demo/image/upload/screenshot.jpg";

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

const groqBody = (text: string) => JSON.stringify({ choices: [{ message: { content: text } }] });
const geminiBody = (text: string) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

function fakeImageResponse() {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
}

function mockFetch(handlers: { groq?: () => Response; gemini?: () => Response; image?: () => Response }) {
  const calls: string[] = [];
  global.fetch = (async (url: string) => {
    if (url === IMAGE_URL) {
      calls.push("image");
      return (handlers.image ?? fakeImageResponse)();
    }
    if (url.includes("api.groq.com")) {
      calls.push("groq");
      if (!handlers.groq) throw new Error("unexpected Groq call");
      return handlers.groq();
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      calls.push("gemini");
      if (!handlers.gemini) throw new Error("unexpected Gemini call");
      return handlers.gemini();
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  return calls;
}

test("Gemini answers -> used directly, Groq never called", async () => {
  const calls = mockFetch({
    gemini: () => new Response(geminiBody('{"utr":"123456789012","amount":2200}'), { status: 200 }),
  });
  const { callVision } = await import(`../src/lib/vision?t=${Date.now()}`);
  const text = await callVision({ prompt: "extract", imageUrl: IMAGE_URL, label: "test" });
  assert.equal(text, '{"utr":"123456789012","amount":2200}');
  assert.deepEqual(calls, ["image", "gemini"]);
});

test("Gemini HTTP error (denied key) -> falls back to Groq", async () => {
  const calls = mockFetch({
    gemini: () => new Response("permission denied", { status: 403 }),
    groq: () => new Response(groqBody('{"utr":"999888777666","amount":100}'), { status: 200 }),
  });
  const { callVision } = await import(`../src/lib/vision?t=${Date.now()}`);
  const text = await callVision({ prompt: "extract", imageUrl: IMAGE_URL, label: "test" });
  assert.equal(text, '{"utr":"999888777666","amount":100}');
  assert.deepEqual(calls, ["image", "gemini", "groq"]);
});

test("Gemini image fetch fails -> falls back to Groq (image fetched again for Groq's own call is unaffected — Groq fetches by URL server-side)", async () => {
  const calls = mockFetch({
    image: () => new Response("not found", { status: 404 }),
    groq: () => new Response(groqBody('{"utr":"111122223333","amount":50}'), { status: 200 }),
  });
  const { callVision } = await import(`../src/lib/vision?t=${Date.now()}`);
  const text = await callVision({ prompt: "extract", imageUrl: IMAGE_URL, label: "test" });
  assert.equal(text, '{"utr":"111122223333","amount":50}');
  assert.deepEqual(calls, ["image", "groq"]);
});

test("No Gemini key configured -> goes straight to Groq", async () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["EMBEDDINGS_API_KEY", "GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GEMINI_API_KEY_4", "GEMINI_API_KEY_5"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const calls = mockFetch({
      groq: () => new Response(groqBody('{"utr":"444455556666","amount":75}'), { status: 200 }),
    });
    const { callVision } = await import(`../src/lib/vision?t=${Date.now()}`);
    const text = await callVision({ prompt: "extract", imageUrl: IMAGE_URL, label: "test" });
    assert.equal(text, '{"utr":"444455556666","amount":75}');
    assert.deepEqual(calls, ["groq"]);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test("REGRESSION: Gemini splits its reply across multiple parts -> all of them are joined, not just parts[0]", async () => {
  // A real College ID check returned a 7-character response ('{\n  "is')
  // when only parts[0].text was read. This join fix is still correct
  // defensive behavior even though it turned out NOT to be the live root
  // cause of that specific truncation — a genuinely multi-part reply must
  // still be assembled in full.
  const calls = mockFetch({
    gemini: () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: '{\n  "is_id_card": true,\n  ' },
        { text: '"has_signature": false,\n  "notes": null\n}' },
      ] } }],
    }), { status: 200 }),
  });
  const { callVision } = await import(`../src/lib/vision?t=${Date.now()}`);
  const text = await callVision({ prompt: "check id", imageUrl: IMAGE_URL, label: "test" });
  assert.equal(text, '{\n  "is_id_card": true,\n  "has_signature": false,\n  "notes": null\n}');
  assert.deepEqual(calls, ["image", "gemini"]);
});

test("REGRESSION: thinkingConfig must NOT be sent to Gemini — confirmed live it makes the API reject the request with 400 INVALID_ARGUMENT", async () => {
  // Tried thinkingConfig.thinkingBudget:0 as a fix for the 7-char
  // truncation. Live result: Gemini returned 400 INVALID_ARGUMENT — this
  // model/API combo doesn't accept that field at all, so the call never
  // even reached a real answer. Reverted. Pin that the field stays gone so
  // it doesn't silently come back in a future "fix".
  let capturedBody: any = null;
  const origFetch = global.fetch;
  global.fetch = (async (url: string, init?: any) => {
    if (url === IMAGE_URL) return fakeImageResponse();
    if (typeof url === "string" && url.includes("generativelanguage.googleapis.com")) {
      capturedBody = JSON.parse(init.body);
      return new Response(geminiBody('{"is_id_card":true,"has_signature":true,"notes":null}'), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
  try {
    const { callVision } = await import(`../src/lib/vision?t=${Date.now()}`);
    await callVision({ prompt: "check id", imageUrl: IMAGE_URL, label: "test", maxTokens: 200 });
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(capturedBody.generationConfig.thinkingConfig, undefined, "thinkingConfig broke the live API call with 400 — must not be sent");
  assert.ok(capturedBody.generationConfig.maxOutputTokens >= 1024, "maxOutputTokens should have a raised floor, not the raw 200 passed in");
});

test("Gemini returns a part with no text at all (e.g. empty finish) -> falls back to Groq, not a crash", async () => {
  const calls = mockFetch({
    gemini: () => new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }), { status: 200 }),
    groq: () => new Response(groqBody('{"utr":"777788889999","amount":10}'), { status: 200 }),
  });
  const { callVision } = await import(`../src/lib/vision?t=${Date.now()}`);
  const text = await callVision({ prompt: "extract", imageUrl: IMAGE_URL, label: "test" });
  assert.equal(text, '{"utr":"777788889999","amount":10}');
  assert.deepEqual(calls, ["image", "gemini", "groq"]);
});

test("Both providers fail -> null", async () => {
  const calls = mockFetch({
    gemini: () => new Response("bad gateway", { status: 502 }),
    groq: () => new Response("bad gateway", { status: 502 }),
  });
  const { callVision } = await import(`../src/lib/vision?t=${Date.now()}`);
  const text = await callVision({ prompt: "extract", imageUrl: IMAGE_URL, label: "test" });
  assert.equal(text, null);
  assert.deepEqual(calls, ["image", "gemini", "groq"]);
});

async function main() {
  let failed = 0;
  const origFetch = global.fetch;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`  ok  - ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  - ${c.name}`);
      console.error(err);
    } finally {
      global.fetch = origFetch;
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
