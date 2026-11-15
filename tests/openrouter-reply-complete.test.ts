import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { completeAnswer, endsMidSentence } from "../src/lib/intent-engine/answer-text.ts";

// The live failure: support-bot replies came back cut off mid-sentence.
// The last un-fixed provider on that path was OpenRouter, still capped at
// max_tokens: 300 (Gemini already uses 1024, Groq 600). A longer grounded
// answer arrived with finish_reason "length" and its tail — usually the
// next step — was lost. The fix: raise OpenRouter to 600, matching Groq's
// CHAT_MAX_TOKENS. completeAnswer below is the safety net for any cut
// that still happens: the student gets the last finished sentence, never
// half of one.
//
// NOTE on why the budget is asserted on the source, not via a mocked
// fetch: generateBotAnswerOpenRouter cannot be imported under the repo's
// `node --test` runner — its dependency chain uses extensionless relative
// imports ("./groq-provider"), which Node's ESM type-stripping does not
// resolve. The request-budget behaviour was verified separately with a
// mocked fetch (see report); this file guards the fix against regression
// in the suite that actually runs.

const providerSrc = readFileSync(
  new URL("../src/lib/intent-engine/openrouter-provider.ts", import.meta.url),
  "utf8",
);

test("OpenRouter asks for a 600-token budget, not the 300 that cut replies off", () => {
  // 300 tokens ≈ 225 words: a grounded multi-step answer (fee + batch +
  // Route Map + next step) routinely needed more and came back
  // finish_reason "length", cut mid-sentence.
  assert.ok(providerSrc.includes("max_tokens: 600"), "expected max_tokens: 600 in openrouter-provider.ts");
  assert.ok(!providerSrc.includes("max_tokens: 300"), "the 300-token cap must be gone");
});

test("the provider still trims a length-truncated reply instead of showing it cut off", () => {
  assert.ok(
    providerSrc.includes('completeAnswer(text, choice?.finish_reason === "length")'),
    "expected the finish_reason length guard in openrouter-provider.ts",
  );
});

test("reproduces the live cut-offs: a reply ending mid-sentence is detected", () => {
  // Real fragments from in-app threads (see answer-text.ts header).
  assert.equal(endsMidSentence("Please reach out to the support team through the"), true);
  assert.equal(endsMidSentence("You can see this"), true);
  assert.equal(endsMidSentence("and the fee is ₹1100). To"), true);
  assert.equal(
    endsMidSentence(
      "You can pay the fee on the Payments tab. The fee is Rs 2,200 and once it is approved, " +
        "the Route Map will show the next step. To get your certificates released, you need to",
    ),
    true,
  );
});

test("a cut-off reply is trimmed back to its last finished sentence, never shown half", () => {
  assert.equal(
    completeAnswer(
      "You can pay the fee on the Payments tab. The fee is Rs 2,200 and once it is approved, " +
        "the Route Map will show the next step. To get your certificates released, you need to",
      true,
    ),
    "You can pay the fee on the Payments tab. The fee is Rs 2,200 and once it is approved, the Route Map will show the next step.",
  );
  // No finished sentence worth sending → null, so the caller treats the
  // provider as unavailable and tries the next one instead of half a line.
  assert.equal(completeAnswer("To get your certificates", true), null);
  assert.equal(completeAnswer("Please reach out to the support team through the", true), null);
});

test("a complete reply passes through untouched", () => {
  const full =
    "Your fee is Rs 2,200. Pay it on the Payments tab using UPI, and once it is approved the Route Map " +
    "will show each step for getting your original certificates released.";
  assert.equal(completeAnswer(full, false), full);
  assert.equal(endsMidSentence(full), false);
  assert.equal(endsMidSentence("Thank you"), false);
  assert.equal(endsMidSentence("Your registration is complete. 🙂"), false);
});
