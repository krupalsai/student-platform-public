/**
 * "Teach it all knowledge you have" (platform-scoped): the model was
 * refusing/escalating ordinary questions about how the platform itself
 * works ("App", "Login", "Fee") simply because no admin had manually
 * curated a FAQ row for that exact phrasing yet. PLATFORM_REFERENCE
 * (platform-knowledge.ts) is a static block of the platform's actual
 * documented mechanics — registration, payment, batches, Route Map,
 * petition (general level only), Student App login — always included in
 * the grounding, so the model can answer these directly instead of
 * escalating a question that was never actually unknown.
 *
 * This does NOT loosen the "never invent a specific fact" rule — the
 * block deliberately excludes anything that changes at runtime (exact
 * fees, live seat counts, legal timelines), and the legal/court
 * escalate-always carve-out is untouched.
 *
 * Run with: npx tsx scripts/test-platform-reference.ts
 */
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/lib/intent-engine/groq-provider";
import { PLATFORM_REFERENCE } from "../src/lib/intent-engine/platform-knowledge";

type Case = { name: string; run: () => void };
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

test("student prompt includes the platform reference block", () => {
  const prompt = buildSystemPrompt("student", "", "");
  assert.match(prompt, /PLATFORM REFERENCE/);
  assert.match(prompt, /one-time code/i);
});

test("admin prompt includes the platform reference block too", () => {
  const prompt = buildSystemPrompt("admin", "", "");
  assert.match(prompt, /PLATFORM REFERENCE/);
});

test("grounding rule explicitly permits citing PLATFORM REFERENCE facts", () => {
  const student = buildSystemPrompt("student", "", "");
  assert.match(student, /KNOWLEDGE BASE, STUDENT CONTEXT, or PLATFORM REFERENCE/);
  const admin = buildSystemPrompt("admin", "", "");
  assert.match(admin, /KNOWLEDGE BASE or PLATFORM REFERENCE/);
});

test("SAFETY: the reference never states a specific fee, date, or petition count", () => {
  // Loose but meaningful check: no bare rupee/currency figures, and the
  // petition section explicitly defers exact numbers elsewhere.
  assert.doesNotMatch(PLATFORM_REFERENCE, /₹\d/);
  assert.match(PLATFORM_REFERENCE, /never guess a number here/i);
});

test("SAFETY: the reference explicitly does not cover legal/court outcomes or timelines", () => {
  assert.match(PLATFORM_REFERENCE, /do not describe outcomes, court timelines, or guarantees/i);
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
