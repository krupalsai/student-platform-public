/**
 * A real production College-ID check just returned "[id-ocr] vision model
 * returned non-JSON" — the vision model DID answer, but id-ocr.ts and
 * payment-ocr.ts both did a bare `JSON.parse(text)` with no tolerance for
 * the markdown-fenced or prose-wrapped JSON vision models routinely return,
 * even Gemini's responseMimeType:"application/json" isn't a hard guarantee
 * once Groq's plain-text fallback is the one that actually answered.
 * parseVisionJson() (vision.ts) is the shared, tolerant parser both callers
 * now use instead.
 *
 * Run with: npx tsx scripts/test-parse-vision-json.ts
 */
import assert from "node:assert/strict";
import { parseVisionJson } from "../src/lib/vision";

type Case = { name: string; run: () => void };
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

test("plain JSON parses as-is", () => {
  const r = parseVisionJson('{"is_id_card":true,"has_signature":false}');
  assert.deepEqual(r, { is_id_card: true, has_signature: false });
});

test("JSON wrapped in a ```json fence parses", () => {
  const r = parseVisionJson('```json\n{"is_id_card":true,"has_signature":false}\n```');
  assert.deepEqual(r, { is_id_card: true, has_signature: false });
});

test("JSON wrapped in a bare ``` fence (no language tag) parses", () => {
  const r = parseVisionJson('```\n{"utr":"123456789012","amount":500}\n```');
  assert.deepEqual(r, { utr: "123456789012", amount: 500 });
});

test("JSON with leading/trailing prose still parses via the {...} fallback", () => {
  const r = parseVisionJson('Sure, here is the JSON you asked for:\n{"is_id_card":true,"has_signature":true}\nLet me know if you need anything else!');
  assert.deepEqual(r, { is_id_card: true, has_signature: true });
});

test("REGRESSION: the exact shape id-ocr.ts prompts for, fenced", () => {
  const r = parseVisionJson('```json\n{\n  "is_id_card": true,\n  "has_signature": false,\n  "notes": "signature panel appears blank"\n}\n```');
  assert.deepEqual(r, { is_id_card: true, has_signature: false, notes: "signature panel appears blank" });
});

test("SAFETY: text with no JSON object at all throws (never silently invents data)", () => {
  assert.throws(() => parseVisionJson("I'm not able to read this image clearly."));
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
