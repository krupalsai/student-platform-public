/**
 * normaliseAdminPhone must never mangle a real 10-digit Indian mobile that
 * happens to START with 91.
 *
 * The old implementation was `.replace(/\D/g,"").replace(/^91/,"").slice(-10)`,
 * which turned "9100000001" into "93918719" — eight digits, matching nothing.
 * It had already corrupted a live admin row in production, silently demoting
 * that person to a student on WhatsApp. Same failure mode as bug #33, which
 * was fixed for the MESSAGE command and missed here.
 */
import assert from "node:assert";
import { normaliseAdminPhone } from "../src/lib/whatsapp/admin-service";

function run() {
  // The number this actually broke.
  assert.equal(normaliseAdminPhone("9100000001"), "9100000001");

  // Country code is stripped only from the longer forms, never from the
  // significant digits of a 10-digit number.
  assert.equal(normaliseAdminPhone("919100000001"), "9100000001");
  assert.equal(normaliseAdminPhone("+91 91000 00001"), "9100000001");

  // Ordinary numbers are unaffected.
  assert.equal(normaliseAdminPhone("9000000010"), "9000000010");
  assert.equal(normaliseAdminPhone("+91 90000 00010"), "9000000010");
  assert.equal(normaliseAdminPhone("919000000010"), "9000000010");

  // Must agree with the student-side normalizer, since one is compared
  // against the other on every admin lookup.
  for (const raw of ["9100000001", "919100000001", "+91 90000 00010", "7000000001"]) {
    const digits = raw.replace(/\D/g, "");
    const studentSide = digits.length > 10 ? digits.slice(-10) : digits;
    assert.equal(normaliseAdminPhone(raw), studentSide, `disagrees for ${raw}`);
  }

  console.log("test-admin-phone-normalise: all assertions passed");
}

run();
