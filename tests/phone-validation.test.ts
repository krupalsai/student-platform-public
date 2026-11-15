import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isValidIndianMobile,
  normalizeToLocalPhone,
  toPrefillContact,
} from "../src/lib/whatsapp/phone.ts";

test("normalizeToLocalPhone handles real-world variants", () => {
  assert.equal(normalizeToLocalPhone("9012345678"), "9012345678");
  assert.equal(normalizeToLocalPhone("+919012345678"), "9012345678");
  assert.equal(normalizeToLocalPhone("919012345678"), "9012345678");
  assert.equal(normalizeToLocalPhone("+91 90123 45678"), "9012345678");
  assert.equal(normalizeToLocalPhone("09012345678"), "9012345678");
});

test("normalizeToLocalPhone does NOT strip 91 from a 10-digit number", () => {
  // The old `.replace(/^91/, "")` turned the valid 10-digit number
  // "9112345678" into "12345678" (8 digits), which failed the prefill
  // regex and wrongly blocked the fee page with
  // "couldn't load your registered mobile number".
  assert.equal(normalizeToLocalPhone("9112345678"), "9112345678");
  // Still strips a real country code.
  assert.equal(normalizeToLocalPhone("919112345678"), "9112345678");
});

test("isValidIndianMobile accepts only real Indian mobiles", () => {
  assert.equal(isValidIndianMobile("9012345678"), true);
  assert.equal(isValidIndianMobile("+919012345678"), true);
  assert.equal(isValidIndianMobile("9112345678"), true);
  assert.equal(isValidIndianMobile("12345678"), false); // 8 digits
  assert.equal(isValidIndianMobile("5012345678"), false); // starts with 5
  assert.equal(isValidIndianMobile(""), false);
  assert.equal(isValidIndianMobile(undefined), false);
});

test("toPrefillContact returns 10-digit local form or undefined", () => {
  assert.equal(toPrefillContact("9012345678"), "9012345678");
  assert.equal(toPrefillContact("+919012345678"), "9012345678");
  assert.equal(toPrefillContact("9112345678"), "9112345678");
  assert.equal(toPrefillContact("12345678"), undefined);
  assert.equal(toPrefillContact(undefined), undefined);
});
