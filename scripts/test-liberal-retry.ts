/**
 * Verifies the "retry harder before giving up" behavior added to
 * generateGroundedAnswer(): a strict first pass that escalates gets ONE
 * more attempt with a looser prompt (buildSystemPrompt's `liberal` flag,
 * groq-provider.ts) — permission to give general, non-factual guidance,
 * so a one-off vague question doesn't always ping the admin. The retry
 * must still refuse to guess anything requiring a specific fact, and must
 * still escalate legal/court/timeline questions exactly as the strict pass
 * does — this is the case that matters most to get right.
 *
 * Run with: npx tsx scripts/test-liberal-retry.ts
 */
import assert from "node:assert/strict";

process.env.EMBEDDINGS_API_KEY = "dummy-gemini-key";
delete process.env.GROQ_API_KEY;

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

const geminiBody = (text: string) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

function mockGeminiSequence(replies: string[]) {
  const calls: string[] = [];
  let i = 0;
  global.fetch = (async () => {
    calls.push("gemini");
    const text = replies[Math.min(i, replies.length - 1)];
    i++;
    return new Response(geminiBody(text), { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("strict escalates, liberal retry gives general guidance -> that answer is used", async () => {
  const calls = mockGeminiSequence([
    "ESCALATE",
    "In general, once you submit your fee screenshot an admin reviews it and you're notified on WhatsApp — exact timing can vary, so message support if it's been a while.",
  ]);
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("roughly what happens after I pay", {}, [], []);
  assert.ok(answer && answer.includes("admin reviews"), "expected the liberal retry's general answer to be used");
  assert.deepEqual(calls, ["gemini", "gemini"]);
});

test("SAFETY: strict escalates on a court question, liberal retry ALSO escalates -> still null, never a guess", async () => {
  const calls = mockGeminiSequence(["ESCALATE", "ESCALATE"]);
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("when will the court give its final order", {}, [], []);
  assert.equal(answer, null, "a legal/court question must never get a guessed answer, even from the retry");
  assert.deepEqual(calls, ["gemini", "gemini"]);
});

test("a confident strict answer never triggers the retry at all", async () => {
  const calls = mockGeminiSequence(["The fee is Rs 2200."]);
  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("what's the fee", {}, [], []);
  assert.equal(answer, "The fee is Rs 2200.");
  assert.deepEqual(calls, ["gemini"], "no retry should fire when the strict pass already answered");
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
