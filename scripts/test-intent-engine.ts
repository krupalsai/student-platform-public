/**
 * Manual smoke test for the Intent Engine's failure-handling guarantees.
 * Not wired into a test framework (none exists in this repo yet) — run
 * directly with `npx tsx scripts/test-intent-engine.ts`.
 *
 * Updated from Gemini to Groq: the provider was switched in eec1306,
 * the old gemini-provider.ts deleted in 2e4b4e0, but this file was
 * left importing the deleted module. Fixed here (P0-002).
 *
 * Covers the same requirements as the original:
 *   1. Provider is optional
 *   2. Missing GROQ_API_KEY -> app keeps working (NullIntentClassifier)
 *   3. Timeout / bad JSON / non-2xx -> falls back automatically
 *   4. Never throws to the caller under any of the above
 */
import assert from "node:assert/strict";
import { GroqIntentClassifier } from "../src/lib/intent-engine/groq-provider";
import { getIntentClassifier, UNKNOWN_RESULT } from "../src/lib/intent-engine";

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

// --- 1 & 2: no GROQ_API_KEY set -> factory returns a working no-op classifier ---
test("factory with no GROQ_API_KEY returns UNKNOWN without any network call", async () => {
  const prevKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  const mod = await import("../src/lib/intent-engine");
  const classifier = mod.getIntentClassifier();
  const result = await classifier.classify("hello");
  assert.equal(result.intent, "UNKNOWN");
  assert.equal(typeof result.confidence, "number");

  if (prevKey) process.env.GROQ_API_KEY = prevKey;
});

// --- 3a: request times out -> UNKNOWN with groq_timeout, no throw ---
test("timeout falls back to UNKNOWN_RESULT (reason: groq_timeout)", async () => {
  const origFetch = global.fetch;
  global.fetch = ((_url: string, opts: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = opts.signal as AbortSignal;
      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;

  const classifier = new GroqIntentClassifier("fake-key", { timeoutMs: 50 });
  const result = await classifier.classify("hi");
  assert.equal(result.intent, "UNKNOWN");
  assert.equal(result.reason, "groq_timeout");

  global.fetch = origFetch;
});

// --- 3b: HTTP 429 (quota exceeded) -> UNKNOWN, no throw ---
test("429 quota response falls back to UNKNOWN_RESULT (reason: groq_http_429)", async () => {
  const origFetch = global.fetch;
  global.fetch = async () => new Response("rate limited", { status: 429 }) as Response;

  const classifier = new GroqIntentClassifier("fake-key");
  const result = await classifier.classify("hi");
  assert.equal(result.intent, "UNKNOWN");
  assert.equal(result.reason, "groq_http_429");

  global.fetch = origFetch;
});

// --- 3c: malformed JSON in Groq content -> UNKNOWN, no throw ---
test("invalid JSON in response content falls back to UNKNOWN_RESULT (reason: groq_invalid_json)", async () => {
  const origFetch = global.fetch;
  const groqEnvelope = { choices: [{ message: { content: "not actually json {{{" } }] };
  global.fetch = async () =>
    new Response(JSON.stringify(groqEnvelope), { status: 200 }) as Response;

  const classifier = new GroqIntentClassifier("fake-key");
  const result = await classifier.classify("hi");
  assert.equal(result.intent, "UNKNOWN");
  assert.equal(result.reason, "groq_invalid_json");

  global.fetch = origFetch;
});

// --- 3d: valid JSON but fails schema (bad intent value) -> UNKNOWN, no throw ---
test("schema-invalid JSON falls back to UNKNOWN_RESULT (reason: groq_schema_validation_failed)", async () => {
  const origFetch = global.fetch;
  const badPayload = JSON.stringify({ intent: "NOT_A_REAL_INTENT", confidence: 2, reason: "x", next_action: "y" });
  global.fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: badPayload } }] }),
      { status: 200 }
    ) as Response;

  const classifier = new GroqIntentClassifier("fake-key");
  const result = await classifier.classify("hi");
  assert.equal(result.intent, "UNKNOWN");
  assert.equal(result.reason, "groq_schema_validation_failed");

  global.fetch = origFetch;
});

// --- 3e: valid, well-formed response -> passes through as-is ---
test("valid schema-conforming response is returned unchanged", async () => {
  const origFetch = global.fetch;
  const goodPayload = JSON.stringify({
    intent: "GREETING",
    confidence: 0.95,
    reason: "sender said hello",
    next_action: "reply_politely",
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: goodPayload } }] }),
      { status: 200 }
    ) as Response;

  const classifier = new GroqIntentClassifier("fake-key");
  const result = await classifier.classify("hi");
  assert.equal(result.intent, "GREETING");
  assert.equal(result.confidence, 0.95);

  global.fetch = origFetch;
});

// --- 4: a raw network throw -> UNKNOWN, never propagates ---
test("arbitrary network error falls back to UNKNOWN_RESULT (reason: groq_request_failed)", async () => {
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error("DNS lookup failed"); };

  const classifier = new GroqIntentClassifier("fake-key");
  const result = await classifier.classify("hi");
  assert.equal(result.intent, "UNKNOWN");
  assert.equal(result.reason, "groq_request_failed");

  global.fetch = origFetch;
});

async function main() {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`  ok  - ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  - ${c.name}`);
      console.error(err);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
