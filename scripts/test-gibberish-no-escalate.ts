/**
 * Live: a student mashing the keyboard to test the bot ("Hjs", "Hsh", "Hhe")
 * got escalated to the admin's WhatsApp every single time — random keystrokes
 * are shorter than moderation.ts's repeated-char spam threshold (needs 6+
 * chars) and aren't a repeated character anyway, so nothing caught them
 * before they reached the LLM, which correctly couldn't answer and said
 * ESCALATE — technically correct, but nobody needed a human for a stray
 * "Hjs". buildSystemPrompt now tells the model that meaningless input isn't
 * a real question at all and should get an ordinary, brief, human reply
 * instead of ESCALATE — never a ticket to a person.
 *
 * Run with: npx tsx scripts/test-gibberish-no-escalate.ts
 */
import assert from "node:assert/strict";

process.env.EMBEDDINGS_API_KEY = "dummy-gemini-key";
delete process.env.GROQ_API_KEY;

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

const geminiBody = (text: string) => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

test("REGRESSION: keyboard-mash input gets a normal reply, not ESCALATE (model follows the new instruction)", async () => {
  const calls: string[] = [];
  global.fetch = (async (_url: string, init: any) => {
    calls.push("gemini");
    const body = JSON.parse(init.body);
    const systemPrompt: string = body.systemInstruction.parts[0].text;
    assert.match(systemPrompt, /meaningless/i, "prompt must instruct the model to treat gibberish as a non-question");
    assert.match(systemPrompt, /Never respond with ESCALATE for this/i);
    // Simulate the model actually following the new instruction.
    return new Response(geminiBody("Hey, didn't quite catch that — what do you need help with? 😊"), { status: 200 });
  }) as typeof fetch;

  const { generateGroundedAnswer } = await import(`../src/lib/intent-engine?t=${Date.now()}`);
  const answer = await generateGroundedAnswer("Hjs", {}, [], []);
  assert.ok(answer && !/ESCALATE/i.test(answer), "gibberish must never surface as an ESCALATE / null result");
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
