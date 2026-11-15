/**
 * Live bug: student replied "Fee" -> bot asked "Reply GNIT or GNITC and
 * I'll tell you the exact fee amount for your batch" -> student replied
 * "Gnit" -> bot ignored the fee question entirely and sent "Your GNIT
 * registration is ready" with a Start Registration button. The bare-
 * college-name shortcut in router.ts (handleIncomingWhatsAppMessage) fires
 * on ANY typed college name and always assumed registration, with no
 * awareness that the bot's own last message was actually a fee question.
 *
 * isFeeClarifyingReply() (rule-intent.ts) is what router.ts now checks
 * before assuming "bare college name = start registering".
 *
 * Run with: npx tsx scripts/test-fee-college-reply.ts
 */
import assert from "node:assert/strict";
import { isFeeClarifyingReply } from "../src/lib/whatsapp/rule-intent";

type Case = { name: string; run: () => void };
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

test("REGRESSION: the exact live bot message is recognised as a fee question", () => {
  assert.equal(
    isFeeClarifyingReply("The registration fee depends on your college and current batch. Reply with GNIT or GNITC and I will tell you the exact fee amount for your batch."),
    true,
  );
});

test("a registration prompt (not fee) is NOT treated as a fee question", () => {
  assert.equal(isFeeClarifyingReply("Which college — GNIT or GNITC? Tell me and I will send the registration link on WhatsApp."), false);
});

test("'registration fee' inside a genuine fee question is still recognised (not excluded just for containing 'regist')", () => {
  assert.equal(isFeeClarifyingReply("What's the registration fee for your college?"), true);
});

test("an unrelated message is not a fee question", () => {
  assert.equal(isFeeClarifyingReply("Hi! How can I help you today?"), false);
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
