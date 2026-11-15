/**
 * Defense-in-depth for abuse the word-list moderation filter (ABUSE_WORDS,
 * moderation.ts) doesn't know about yet — that list will always be
 * incomplete (new slurs, misspellings, creative profanity), the same
 * brittleness the gibberish bug had. buildSystemPrompt now also tells
 * Gemini/Groq directly that hostile/abusive input isn't a real question
 * either, so even profanity that slips past the word list still doesn't
 * get escalated to the admin as an unanswered student question.
 *
 * This is a SECOND layer — moderation.ts's word list is still the primary
 * defense and still does the actual warn/mute ladder; this only prevents
 * the LLM from mistaking abuse for a genuine unanswerable question.
 *
 * Run with: npx tsx scripts/test-abuse-not-escalated-by-model.ts
 */
import assert from "node:assert/strict";

process.env.EMBEDDINGS_API_KEY = "dummy-gemini-key";
delete process.env.GROQ_API_KEY;

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

const geminiBody = (text: string) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

test("REGRESSION: system prompt instructs the model to treat abuse as a non-question, not ESCALATE", async () => {
  const calls: string[] = [];
  global.fetch = (async (_url: string, init: any) => {
    calls.push("gemini");
    const body = JSON.parse(init.body);
    const systemPrompt: string = body.systemInstruction.parts[0].text;
    assert.match(systemPrompt, /hostile or abusive/i, "prompt must instruct the model on abusive input");
    assert.match(systemPrompt, /never respond with ESCALATE for this/i);
    // Simulate the model actually following the new instruction.
    return new Response(geminiBody("Let's keep it respectful — happy to help with registration, fees, or documents whenever you're ready."), { status: 200 });
  }) as typeof fetch;

  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("some profanity the word list doesn't know yet", {}, [], []);
  assert.ok(answer && !/ESCALATE/i.test(answer), "abuse must never surface as an ESCALATE / null result from the model side");
  assert.deepEqual(calls, ["gemini"], "no retry should fire — the model answered directly, no escalate happened");
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
