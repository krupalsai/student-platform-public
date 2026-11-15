import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isGatewayStatusQuestion,
  buildGatewayStatusAnswer,
} from "../src/lib/whatsapp/gateway-status-text.ts";

// The reported live failure (2026-10-27): the admin asked "Did cashfree pg
// is working" and the bot replied with the Platform Status snapshot
// (Students: 102, Pending payments: 0, Approved: 59, Active batches: 4)
// because the Groq classifier mapped "is working" to STATUS_REQUEST.
test("the reported question is a gateway-status question", () => {
  assert.equal(isGatewayStatusQuestion("Did cashfree pg is working"), true);
  assert.equal(isGatewayStatusQuestion("Is Cashfree working?"), true);
  assert.equal(isGatewayStatusQuestion("is razorpay working"), true);
  assert.equal(isGatewayStatusQuestion("which gateway is live"), true);
  assert.equal(isGatewayStatusQuestion("which payment gateway is working"), true);
  assert.equal(isGatewayStatusQuestion("pg not working"), true);
  assert.equal(isGatewayStatusQuestion("cashfree down?"), true);
  assert.equal(isGatewayStatusQuestion("Accepting payments"), true);
  assert.equal(isGatewayStatusQuestion("are payments working"), true);
});

test("personal payment questions are NOT gateway questions", () => {
  assert.equal(isGatewayStatusQuestion("my payment failed"), false);
  assert.equal(isGatewayStatusQuestion("payment status"), false);
  assert.equal(isGatewayStatusQuestion("did my payment go through"), false);
  assert.equal(isGatewayStatusQuestion("did i pay"), false);
  assert.equal(isGatewayStatusQuestion("how do I pay the fee"), false);
  assert.equal(isGatewayStatusQuestion("upi failed"), false);
  assert.equal(isGatewayStatusQuestion("amount deducted but payment not confirmed"), false);
  assert.equal(isGatewayStatusQuestion("cashfree"), false);
  assert.equal(isGatewayStatusQuestion(""), false);
});

test("admin answer states the live gateway and the Cashfree block", () => {
  assert.equal(
    buildGatewayStatusAnswer("razorpay", false, "admin"),
    "Yes — payments are working through Razorpay (UPI, debit card, credit card). Cashfree is switched off.",
  );
  const broken = buildGatewayStatusAnswer("cashfree", true, "admin");
  assert.match(broken, /NOT working/);
  assert.match(broken, /not activated yet/);
  assert.match(broken, /8583165/);
  assert.match(broken, /switch it back on in admin Settings/);
  assert.equal(
    buildGatewayStatusAnswer(null, false, "admin"),
    "No payment gateway is switched on right now, so payments are unavailable. Switch one on in admin Settings.",
  );
});

test("student answer has no internal detail", () => {
  assert.equal(
    buildGatewayStatusAnswer("razorpay", false, "student"),
    "Yes — payments are working through Razorpay. You can pay on the Payments tab in the Student App with UPI, debit card, or credit card.",
  );
  const broken = buildGatewayStatusAnswer("cashfree", true, "student");
  assert.match(broken, /not working right now/);
  assert.doesNotMatch(broken, /8583165/);
  assert.doesNotMatch(broken, /transactions are not enabled/);
});
