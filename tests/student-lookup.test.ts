import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseStudentLookupQuery,
  extractPhone,
  formatLookupAnswer,
} from "../src/lib/whatsapp/student-lookup-text.ts";

test("bare phone number is a lookup (plain, +91, spaced)", () => {
  assert.deepEqual(parseStudentLookupQuery("9876543201"), {
    kind: "lookup",
    target: { kind: "phone", phone: "9876543201" },
  });
  assert.deepEqual(parseStudentLookupQuery("+91 9876543201"), {
    kind: "lookup",
    target: { kind: "phone", phone: "9876543201" },
  });
  assert.deepEqual(parseStudentLookupQuery("9876543202"), {
    kind: "lookup",
    target: { kind: "phone", phone: "9876543202" },
  });
});

test("CHECK / LOOKUP / STATUS OF take a phone or a name", () => {
  assert.deepEqual(parseStudentLookupQuery("CHECK 9876543201"), {
    kind: "lookup",
    target: { kind: "phone", phone: "9876543201" },
  });
  assert.deepEqual(parseStudentLookupQuery("check Sample Student"), {
    kind: "lookup",
    target: { kind: "name", name: "Sample Student" },
  });
  assert.deepEqual(parseStudentLookupQuery("STATUS OF 9876543201"), {
    kind: "lookup",
    target: { kind: "phone", phone: "9876543201" },
  });
  assert.deepEqual(parseStudentLookupQuery("CHECK"), { kind: "check-usage" });
});

test("the reported failure: 'Did she paid' is a follow-up, not STATUS", () => {
  assert.deepEqual(parseStudentLookupQuery("Did she paid"), {
    kind: "lookup",
    target: { kind: "followup" },
  });
  assert.deepEqual(parseStudentLookupQuery("Has she paid?"), {
    kind: "lookup",
    target: { kind: "followup" },
  });
  assert.deepEqual(parseStudentLookupQuery("Did she pay?"), {
    kind: "lookup",
    target: { kind: "followup" },
  });
  assert.deepEqual(parseStudentLookupQuery("Did she register"), {
    kind: "lookup",
    target: { kind: "followup" },
  });
  assert.deepEqual(parseStudentLookupQuery("Is he registered?"), {
    kind: "lookup",
    target: { kind: "followup" },
  });
  assert.deepEqual(parseStudentLookupQuery("Did they pay?"), {
    kind: "lookup",
    target: { kind: "followup" },
  });
  assert.deepEqual(parseStudentLookupQuery("She registered?"), {
    kind: "lookup",
    target: { kind: "followup" },
  });
});

test("'Did <name/phone> register?' resolves the target", () => {
  assert.deepEqual(parseStudentLookupQuery("Did Sample Student register?"), {
    kind: "lookup",
    target: { kind: "name", name: "Sample Student" },
  });
  assert.deepEqual(parseStudentLookupQuery("Has 9876543201 paid?"), {
    kind: "lookup",
    target: { kind: "phone", phone: "9876543201" },
  });
  assert.deepEqual(parseStudentLookupQuery("9876543201 did she register?"), {
    kind: "lookup",
    target: { kind: "phone", phone: "9876543201" },
  });
});

test("real commands and stats questions are NOT claimed", () => {
  assert.deepEqual(parseStudentLookupQuery("STATUS"), { kind: "none" });
  assert.deepEqual(parseStudentLookupQuery("HELP"), { kind: "none" });
  assert.deepEqual(parseStudentLookupQuery("New registrations"), { kind: "none" });
  assert.deepEqual(parseStudentLookupQuery("How many registration done today"), {
    kind: "none",
  });
  assert.deepEqual(parseStudentLookupQuery("MESSAGE 9876543203 hi"), { kind: "none" });
  assert.deepEqual(parseStudentLookupQuery("Did I pay?"), { kind: "none" });
});

test("extractPhone never misreads a 12-digit UTR as a phone", () => {
  assert.equal(extractPhone("987654321012"), null);
  assert.equal(extractPhone("UTR 987654321012 paid"), null);
  assert.equal(extractPhone("1234567890"), null);
  assert.equal(extractPhone("call 9876543201 please"), "9876543201");
});

test("bare full name is a lookup candidate; other phrases are not", () => {
  assert.deepEqual(parseStudentLookupQuery("Sample Student"), {
    kind: "bare-name",
    name: "Sample Student",
  });
  assert.deepEqual(parseStudentLookupQuery("New batch idea"), { kind: "none" });
});

test("Sample Student's real case formats as started-but-not-registered", () => {
  const answer = formatLookupAnswer({
    kind: "found",
    phone: "9876543201",
    profile: {
      full_name: null,
      is_profile_complete: false,
      created_at: "2026-10-15T06:05:49.937753+00:00",
      batches: null,
    },
    payment: { status: "none", amount: null, paidAt: null },
  });
  assert.match(answer, /Not registered yet/);
  assert.match(answer, /Batch: none/);
  assert.match(answer, /No payment yet/);
  assert.match(answer, /Profile created: 15 Oct 2026/);
  assert.match(answer, /Name not filled in/);
});

test("a registered, paid student formats with batch and payment", () => {
  const answer = formatLookupAnswer({
    kind: "found",
    phone: "9876543202",
    profile: {
      full_name: "Test Student",
      is_profile_complete: true,
      created_at: "2026-10-01T05:00:00.000Z",
      batches: { name: "GNIT Batch 2", college: "GNIT" },
    },
    payment: { status: "paid", amount: 2200, paidAt: "2026-10-02T05:00:00.000Z", gateway: "Razorpay" },
  });
  assert.match(answer, /✅ Registered/);
  assert.match(answer, /GNIT Batch 2 \(GNIT\)/);
  assert.match(answer, /✅ Paid ₹2,200 on 2 Oct 2026 via Razorpay/);
});

test("payment gateway shows on paid and pending answers; spot is 'in person'", () => {
  const paidViaPhonePe = formatLookupAnswer({
    kind: "found",
    phone: "9876543204",
    profile: {
      full_name: "Paid Student",
      is_profile_complete: true,
      created_at: "2026-10-01T05:00:00.000Z",
      batches: { name: "GNITC Batch 1", college: "GNITC" },
    },
    payment: { status: "paid", amount: 2200, paidAt: "2026-10-03T05:00:00.000Z", gateway: "PhonePe" },
  });
  assert.match(paidViaPhonePe, /✅ Paid ₹2,200 on 3 Oct 2026 via PhonePe/);

  const pendingViaRazorpay = formatLookupAnswer({
    kind: "found",
    phone: "9876543205",
    profile: {
      full_name: "Pending Student",
      is_profile_complete: true,
      created_at: "2026-10-01T05:00:00.000Z",
      batches: { name: "GNIT Batch 2", college: "GNIT" },
    },
    payment: { status: "pending", amount: 2200, paidAt: null, gateway: "Razorpay" },
  });
  assert.match(pendingViaRazorpay, /⏳ Payment pending — ₹2,200 submitted via Razorpay, waiting for approval/);

  const paidSpot = formatLookupAnswer({
    kind: "found",
    phone: "9876543206",
    profile: {
      full_name: "Spot Student",
      is_profile_complete: true,
      created_at: "2026-10-01T05:00:00.000Z",
      batches: { name: "GNIT Batch 2", college: "GNIT" },
    },
    payment: { status: "paid", amount: 2200, paidAt: "2026-10-04T05:00:00.000Z", gateway: "in person" },
  });
  assert.match(paidSpot, /✅ Paid ₹2,200 on 4 Oct 2026 \(in person\)/);
  assert.doesNotMatch(paidSpot, /via in person/);

  // No gateway known: the line is exactly as before, no dangling "via".
  const paidUnknownGateway = formatLookupAnswer({
    kind: "found",
    phone: "9876543207",
    profile: {
      full_name: "Old Student",
      is_profile_complete: true,
      created_at: "2026-10-01T05:00:00.000Z",
      batches: { name: "GNIT Batch 2", college: "GNIT" },
    },
    payment: { status: "paid", amount: 2200, paidAt: "2026-10-02T05:00:00.000Z", gateway: null },
  });
  assert.match(paidUnknownGateway, /✅ Paid ₹2,200 on 2 Oct 2026$/m);
  assert.doesNotMatch(paidUnknownGateway, /via/);
});

test("not-found and ambiguous answers say what to do next", () => {
  assert.match(
    formatLookupAnswer({ kind: "not-found-phone", phone: "9876543201" }),
    /hasn't started registration/,
  );
  assert.match(
    formatLookupAnswer({ kind: "not-found-name", name: "Nobody Here" }),
    /couldn't find a student named/,
  );
  const amb = formatLookupAnswer({
    kind: "ambiguous",
    nameQuery: "Asha Rao",
    matches: [
      { id: "1", full_name: "Asha Rao", phone: "9876543203" },
      { id: "2", full_name: "Asha Rao", phone: "9876543208" },
    ],
  });
  assert.match(amb, /98765XXXXX/);
  assert.match(amb, /91234XXXXX/);
  assert.match(amb, /Resend with the full phone number/);
});
