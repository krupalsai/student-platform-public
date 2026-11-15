/**
 * Regression for a live prod miss: "Okay thankyou" (WhatsApp, UQ-049) still
 * reached the admin as an unanswered question after the exact-phrase
 * CLOSING_GREETINGS fix, because "okay thankyou" isn't spelled out as its
 * own exact phrase — only "okay" and "thank you" are, separately.
 * classifyContent() now also treats a message built ENTIRELY from
 * known sign-off words as a closing remark, regardless of the exact
 * combination, while never swallowing a real question.
 *
 * Run with: npx tsx scripts/test-closing-word-combos.ts
 */
import assert from "node:assert/strict";
import { classifyContent } from "../src/lib/whatsapp/moderation";

type Case = { name: string; run: () => void };
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

test("REGRESSION: 'Okay thankyou' (UQ-049) is a closing remark, not a question", () => {
  assert.equal(classifyContent("Okay thankyou"), "greeting_close");
});

test("'ok thanks bye' (three closing words) is still a closing remark", () => {
  assert.equal(classifyContent("ok thanks bye"), "greeting_close");
});

test("'thank you okay' (mixed case, extra word) is still a closing remark", () => {
  assert.equal(classifyContent("Thank You Okay"), "greeting_close");
});

test("bare 'okay' still works (unchanged from the earlier fix)", () => {
  assert.equal(classifyContent("Okay"), "greeting_close");
});

test("'App download' — a real question — is never mistaken for a closing remark", () => {
  assert.equal(classifyContent("App download"), "question");
});

test("a genuine question that happens to include short words isn't swallowed", () => {
  assert.equal(classifyContent("when is it due"), "question");
  assert.equal(classifyContent("do you accept online payment"), "question");
});

test("6+ words of otherwise-closing vocabulary is capped out, not auto-classified as closing", () => {
  assert.notEqual(classifyContent("ok ok ok ok ok ok"), "greeting_close");
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
