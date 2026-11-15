import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isOwnStatusQuestion,
  extractMentionedPhones,
  extractOtherStudentPhone,
  formatOwnStatus,
  isAdminRole,
  assertUnifiedAdminActor,
} from "../src/lib/unified-agent-pure.ts";
import type { UnifiedStudentSnapshot } from "../src/lib/unified-agent-pure.ts";

const snapshot: UnifiedStudentSnapshot = {
  registrationComplete: true,
  batch: { name: "GNIT Batch 1", status: "active" },
  payment: { state: "submitted", amount: 2500 },
  gate: { fee: 2500 },
  caseInfo: { number: "WP 12345 / 2026", status: "PENDING", nextHearing: "2026-11-05" },
  openCases: 1,
};

test("own-status questions are detected, new questions are not", () => {
  assert.equal(isOwnStatusQuestion("what is my payment status?"), true);
  assert.equal(isOwnStatusQuestion("check my status"), true);
  assert.equal(isOwnStatusQuestion("have i paid?"), true);
  assert.equal(isOwnStatusQuestion("my question is about certificates"), false);
  assert.equal(isOwnStatusQuestion("what is the fee?"), false);
  assert.equal(isOwnStatusQuestion("how do i pay the fee?"), false);
});

test("other-student phone guard: own number passes, another number is refused", () => {
  assert.deepEqual(extractMentionedPhones("check 9876543201 please"), ["9876543201"]);
  assert.equal(extractOtherStudentPhone("my number is 9876543201, check my status", ["+919876543201"]), null);
  assert.equal(extractOtherStudentPhone("check payment of 9876543202", ["9876543201"]), "9876543202");
  assert.equal(extractOtherStudentPhone("what is my status?", ["9876543201"]), null);
});

test("own status uses the live batch fee, never a hardcoded one, and hides amounts on WhatsApp", () => {
  const app = formatOwnStatus(snapshot, "app");
  assert.match(app, /₹2500/);
  assert.match(app, /WP 12345 \/ 2026/);
  assert.match(app, /Open support cases waiting for the team: 1/);
  const wa = formatOwnStatus(snapshot, "whatsapp");
  assert.doesNotMatch(wa, /₹/);
  assert.match(wa, /Student App Payments tab/);
});

test("admin guard: only admin roles pass", () => {
  assert.equal(isAdminRole("admin"), true);
  assert.equal(isAdminRole("super_admin"), true);
  assert.equal(isAdminRole("student"), false);
  assert.equal(assertUnifiedAdminActor({ role: "student" }), "Only admins can perform that action.");
  assert.equal(assertUnifiedAdminActor({ role: "admin" }), null);
});
