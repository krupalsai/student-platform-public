import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lexicalScore, rankFaqs } from "../../src/lib/services/faq-ranking";
const entries = [
  { id: "1", category: null, question: "How do I check payment status?", answer: "Open the payments tab." },
  { id: "2", category: null, question: "How do I register for a batch?", answer: "Open registration." },
  { id: "3", category: null, question: "When is the court date?", answer: "Ask the team." },
];
test("one shared word never returns a direct FAQ candidate", () => {
  assert.equal(lexicalScore("payment problem ayindi", entries[0].question), 0);
  assert.deepEqual(rankFaqs("my payment issue", entries), []);
});
test("relevant FAQ is ranked before unrelated answers", () => {
  assert.equal(rankFaqs("how check payment status", entries)[0]?.id, "1");
  assert.equal(rankFaqs("register for batch", entries)[0]?.id, "2");
});
test("unrelated court question does not select payment guidance", () => {
  assert.deepEqual(rankFaqs("court timeline tomorrow", entries), []);
});

test("mixed Telugu-English with a clear topic stays in the right candidate set", () => {
  assert.equal(rankFaqs("na payment status ela check cheyali", entries)[0]?.id, "1");
});
test("single-word follow-up is not forced to a random FAQ", () => {
  assert.deepEqual(rankFaqs("which one", entries), []);
});
test("vague payment question does not assert a fee or payment procedure", () => {
  assert.deepEqual(rankFaqs("fee entha", entries), []);
});

import { inAppShortReply, completeSupportReply } from "../../src/lib/services/support-response-guard";
test("Call in app does not send student to WhatsApp or claim a call was placed", () => {
  const reply = inAppShortReply("Call") ?? "";
  assert.match(reply, /Tell me what happened/);
  assert.doesNotMatch(reply, /WhatsApp|called the admin/i);
});
test("Req after Call asks for issue instead of an incomplete action", () => {
  assert.match(inAppShortReply("Req", "Call") ?? "", /Tell me what happened/);
  assert.match(completeSupportReply("To request a call or get direct support, tap"), /couldn't finish/i);
});
test("Where to app acknowledges student is already inside the app", () => {
  assert.match(inAppShortReply("Where to app") ?? "", /already in the Student App/i);
});
test("exact Call then Request stays in app and clarifies callback issue", () => {
  const first = inAppShortReply("Call") ?? "";
  const second = inAppShortReply("Request", "Call") ?? "";
  assert.match(first, /Tell me what happened/);
  assert.match(second, /Tell me what happened/);
  assert.doesNotMatch(first + second, /WhatsApp|call the admin|Bonafide|open the Student App/i);
});
test("Request without a clear object asks what is requested, not bonafide steps", () => {
  const reply = inAppShortReply("Request") ?? "";
  assert.match(reply, /What would you like to request/);
  assert.doesNotMatch(reply, /Bonafide|registration|payment|Route Map/i);
});


import { PLATFORM_REFERENCE } from "../../src/lib/intent-engine/platform-knowledge";
test("payment guidance does not turn batch minimum into a payment gate", () => {
  assert.match(PLATFORM_REFERENCE, /batch minimum is not a payment gate/i);
  assert.match(PLATFORM_REFERENCE, /manual UPI.*reviewed separately by an admin/i);
  assert.doesNotMatch(PLATFORM_REFERENCE, /only then does the admin announce|never happens automatically/i);
});
test("registration instructions include the required gender field", () => {
  assert.match(PLATFORM_REFERENCE, /father's name, gender, phone/i);
});

test("bare fee question points to Payments tab without inventing an amount", () => {
  for (const caption of ["Fee", "fees", "fee entha"]) {
    const reply = inAppShortReply(caption) ?? "";
    assert.match(reply, /Payments tab/);
    assert.doesNotMatch(reply, /Rs ?\d|rupees \d|\d{3,}/);
  }
});
test("bare login question explains one-time code, no password", () => {
  const reply = inAppShortReply("login") ?? "";
  assert.match(reply, /one-time code/i);
  assert.match(reply, /no password/i);
});
test("bare certificate question points to the Route Map", () => {
  for (const caption of ["certificate", "bonafide", "originals"]) {
    assert.match(inAppShortReply(caption) ?? "", /Route Map/);
  }
});
test("bare petition question gives process only, never outcomes or timelines", () => {
  const reply = inAppShortReply("petition") ?? "";
  assert.match(reply, /minimum number of students/i);
  assert.doesNotMatch(reply, /guarantee|will win|court date|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
});
test("bare help offers topics and invites the student's own words", () => {
  const reply = inAppShortReply("help") ?? "";
  assert.match(reply, /registration, fees and payment/);
  assert.match(reply, /What do you need\?/);
});
test("bare status asks which status instead of guessing one", () => {
  assert.match(inAppShortReply("status") ?? "", /payment or registration/i);
});
test("bare register explains the real registration flow", () => {
  const reply = inAppShortReply("registration") ?? "";
  assert.match(reply, /college's link/);
  assert.match(reply, /one-time code/);
});
test("in-app replies never leak WhatsApp asterisk markup", () => {
  assert.equal(completeSupportReply("Open the *Payments* tab and tap *Pay*."), "Open the Payments tab and tap Pay.");
  assert.match(completeSupportReply("To check, reply *login* and tap"), /couldn't finish/i);
});


test("call variants ask for issue details without promising a call", () => {
  for (const caption of ["Call", "callback", "call me", "Req"]) {
    const reply = inAppShortReply(caption, "Call") ?? "";
    assert.match(reply, /Tell me what happened/);
    assert.doesNotMatch(reply, /AI callback|call.*shortly|request a call/i);
  }
});
