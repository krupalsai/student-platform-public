/**
 * Verifies generateGroundedAnswer() tries Gemini first (primary) and only
 * falls back to Groq when Gemini is genuinely unavailable (no key, network
 * error, bad HTTP status) — never when Gemini successfully answers "I don't
 * know" (ESCALATE). Asking a second model to guess from the same limited
 * grounding on a question the primary already declined risks a confidently
 * wrong answer instead of the honest escalation to a human, which matters
 * most on exactly the legal/court questions this bot has to be careful
 * about.
 *
 * Run with: npx tsx scripts/test-gemini-fallback.ts
 */
import assert from "node:assert/strict";

process.env.GROQ_API_KEY = "dummy-groq-key";
process.env.EMBEDDINGS_API_KEY = "dummy-gemini-key";

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

const groqBody = (text: string) => JSON.stringify({ choices: [{ message: { content: text } }] });
const geminiBody = (text: string) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

function mockFetch(handlers: { groq?: () => Response; gemini?: () => Response }) {
  const calls: string[] = [];
  global.fetch = (async (url: string) => {
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

test("Gemini answers confidently -> used directly, Groq never called", async () => {
  const calls = mockFetch({
    gemini: () => new Response(geminiBody("The fee is Rs 2200."), { status: 200 }),
  });
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("what's the fee", {}, [], []);
  assert.equal(answer, "The fee is Rs 2200.");
  assert.deepEqual(calls, ["gemini"]);
});

test("Gemini says ESCALATE twice (strict, then the liberal retry) -> null, Groq never called", async () => {
  const calls = mockFetch({
    gemini: () => new Response(geminiBody("ESCALATE"), { status: 200 }),
  });
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("will the court definitely rule in our favor", {}, [], []);
  assert.equal(answer, null);
  assert.deepEqual(calls, ["gemini", "gemini"]);
});

test("Gemini HTTP error (e.g. denied key) -> falls back to Groq, Groq's answer is used", async () => {
  const calls = mockFetch({
    gemini: () => new Response("permission denied", { status: 403 }),
    groq: () => new Response(groqBody("Payment opens once the batch is full."), { status: 200 }),
  });
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("when does payment open", {}, [], []);
  assert.equal(answer, "Payment opens once the batch is full.");
  assert.deepEqual(calls, ["gemini", "groq"]);
});

test("Gemini network failure -> falls back to Groq", async () => {
  const calls = mockFetch({
    gemini: () => { throw new Error("network down"); },
    groq: () => new Response(groqBody("Reply GNIT or GNITC to register."), { status: 200 }),
  } as any);
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("how do I register", {}, [], []);
  assert.equal(answer, "Reply GNIT or GNITC to register.");
  assert.deepEqual(calls, ["gemini", "groq"]);
});

test("Gemini unavailable AND Groq escalates twice (strict, then retry) -> null, not a guess", async () => {
  const calls = mockFetch({
    gemini: () => new Response("bad gateway", { status: 502 }),
    groq: () => new Response(groqBody("ESCALATE"), { status: 200 }),
  });
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("some obscure question", {}, [], []);
  assert.equal(answer, null);
  assert.deepEqual(calls, ["gemini", "groq", "groq"]);
});

test("Gemini unavailable AND no Groq key configured -> null, Groq never attempted", async () => {
  const prevGroq = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  const calls = mockFetch({
    gemini: () => new Response("server error", { status: 500 }),
  });
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("anything", {}, [], []);
  assert.equal(answer, null);
  assert.deepEqual(calls, ["gemini"]);
  if (prevGroq) process.env.GROQ_API_KEY = prevGroq;
});

test("No Gemini key configured -> goes straight to Groq", async () => {
  const prevGemini = process.env.EMBEDDINGS_API_KEY;
  delete process.env.EMBEDDINGS_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const calls = mockFetch({
    groq: () => new Response(groqBody("The batch is GNIT Batch 2."), { status: 200 }),
  });
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("which batch am I in", {}, [], []);
  assert.equal(answer, "The batch is GNIT Batch 2.");
  assert.deepEqual(calls, ["groq"]);
  if (prevGemini) process.env.EMBEDDINGS_API_KEY = prevGemini;
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
