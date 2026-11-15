/**
 * Live bug: "Fuck" and "Fuckoff" matched nothing in ABUSE_WORDS (it only
 * had "stupid"/"idiot"/Hinglish terms — no plain English profanity at
 * all), so classifyContent() returned "question" for both. They reached
 * Gemini, which correctly declined to answer them, and got escalated to
 * the admin's WhatsApp as unanswered student questions — exactly the kind
 * of noise the abuse-moderation ladder (warn → firmer note → final
 * warning → mute) exists to handle instead.
 *
 * Run with: npx tsx scripts/test-profanity-not-escalated.ts
 */
import assert from "node:assert/strict";
import { classifyContent } from "../src/lib/whatsapp/moderation";

type Case = { name: string; run: () => void };
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

test("REGRESSION: 'Fuck' is caught as abuse, not sent to admin as a question", () => {
  assert.equal(classifyContent("Fuck"), "spam");
});

test("REGRESSION: 'Fuckoff' is caught as abuse", () => {
  assert.equal(classifyContent("Fuckoff"), "spam");
});

test("other plain-English profanity is caught", () => {
  for (const w of ["fuck off", "wtf is this", "bullshit answer", "you bastard", "asshole bot"]) {
    assert.equal(classifyContent(w), "spam", `expected "${w}" to be classified as spam`);
  }
});

test("Hindi/Telugu profanity additions are caught", () => {
  for (const w of ["madarchod", "behenchod", "bhosdi ke", "harami"]) {
    assert.equal(classifyContent(w), "spam", `expected "${w}" to be classified as spam`);
  }
});

test("a genuine question is never swallowed by the new profanity words", () => {
  assert.equal(classifyContent("What documents do I need for registration?"), "question");
  assert.equal(classifyContent("How much is the fee for GNIT"), "question");
});

async function main() {
  let failed = 0;
  for (const c of cases) {
    try {
      c.run();
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
