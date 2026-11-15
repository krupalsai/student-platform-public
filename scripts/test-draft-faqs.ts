/**
 * Self-learning FAQ drafts — the assistant saves a draft (faqs.enabled =
 * false) every time it answers a question with no FAQ match at all,
 * instead of that unreviewed AI answer going live automatically. This
 * covers the pure parts: display-id formatting and the list message, plus
 * the gibberish guard that stops trivial test messages ("Hjs", "ok") from
 * flooding the review queue.
 *
 * Run with: npx tsx scripts/test-draft-faqs.ts
 */
import assert from "node:assert/strict";
import { displayIdFor, formatDraftFaqs, type DraftFaq } from "../src/lib/whatsapp/draft-faqs";
import { looksLikeRealQuestion } from "../src/lib/whatsapp/rule-intent";

type Case = { name: string; run: () => void };
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

test("displayIdFor takes the first 8 chars of the UUID", () => {
  assert.equal(displayIdFor("a1b2c3d4-e5f6-7890-abcd-ef1234567890"), "a1b2c3d4");
});

test("empty queue reads as done, not an error", () => {
  const msg = formatDraftFaqs([], 0);
  assert.match(msg, /No pending drafts/i);
});

test("a listed draft shows its question and answer, plus how to act on it", () => {
  const drafts: DraftFaq[] = [
    { id: "a1b2c3d4-1111", displayId: "a1b2c3d4", question: "What documents do I need?", answer: "Your college ID and basic details.", createdAt: new Date().toISOString() },
  ];
  const msg = formatDraftFaqs(drafts, 1);
  assert.match(msg, /a1b2c3d4/);
  assert.match(msg, /What documents do I need\?/);
  assert.match(msg, /Your college ID and basic details\./);
  assert.match(msg, /APPROVE a1b2c3d4/);
  assert.match(msg, /REJECT a1b2c3d4/);
});

test("a capped list says how many more there are", () => {
  const drafts: DraftFaq[] = [{ id: "aaaaaaaa-1", displayId: "aaaaaaaa", question: "Q1", answer: "A1", createdAt: null }];
  const msg = formatDraftFaqs(drafts, 5);
  assert.match(msg, /1 of 5/);
});

test("REGRESSION: gibberish test messages never qualify as a real question", () => {
  for (const q of ["Hjs", "Hsh", "Hhe", "ok", "hi", "asdf"]) {
    assert.equal(looksLikeRealQuestion(q), false, `"${q}" should not look like a real question`);
  }
});

test("a genuine short-but-real question still qualifies", () => {
  assert.equal(looksLikeRealQuestion("What is the fee amount?"), true);
  assert.equal(looksLikeRealQuestion("How do I download the app"), true);
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
