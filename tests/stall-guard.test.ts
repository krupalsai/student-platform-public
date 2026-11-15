import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isStallPromise } from "../src/lib/intent-engine/stall-guard.ts";

// The reported live failure: the bot answered "Let me check her records."
// to "Did she paid" and never followed up.
test("the reported stall is caught", () => {
  assert.equal(isStallPromise("Let me check her records."), true);
  assert.equal(isStallPromise("Let me check her records"), true);
  assert.equal(isStallPromise("Let me check if she paid."), true);
  assert.equal(isStallPromise("I'll check and get back to you."), true);
  assert.equal(isStallPromise("I will check that for you."), true);
  assert.equal(isStallPromise("I don't have that detail here. I'll check with the team and let you know."), true);
  assert.equal(isStallPromise("Checking on that for you."), true);
  assert.equal(isStallPromise("Let me look into it."), true);
  assert.equal(isStallPromise("Give me a moment, let me check."), true);
});

test("a reply that also delivers an answer is not a stall", () => {
  assert.equal(
    isStallPromise("Let me check your payment status — Paid ₹2,200 on 2 Oct 2026 via Razorpay."),
    false,
  );
  assert.equal(isStallPromise("She is registered. Batch: GNIT Batch 2 (GNIT). Payment: Paid ₹2,200 on 2 Oct 2026."), false);
  assert.equal(isStallPromise("No payment yet. They need to finish registration in the Student App."), false);
  assert.equal(isStallPromise("The fee is ₹2,200. Check the Payments tab in the Student App for the status."), false);
});

test("ordinary answers without any check-promise are untouched", () => {
  assert.equal(isStallPromise(""), false);
  assert.equal(isStallPromise("Your registration is complete."), false);
  assert.equal(isStallPromise("I don't know the answer to that."), false);
  assert.equal(isStallPromise("Which college are you from, GNIT or GNITC?"), false);
});
