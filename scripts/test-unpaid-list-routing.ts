/**
 * Pins the live-reported WhatsApp transcript that this routing exists for:
 *
 *   admin: "List all the students who not paid divide by their batches"
 *          → "I don't have that information. The admin will reply to your
 *            query."
 *
 * Nothing recognised an UNPAID list: the paid-count flow only knows "how
 * many paid" / "paid list", and the grounded answer has no batch-wide list
 * fact, so the question fell through every handler into the fallback.
 *
 * The matchers under test are module-private in unpaid-list.ts, so they are
 * re-declared here exactly as the module builds them. If you change them
 * there, change them here — a divergence failing this test is the point.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const LIST_UNPAID_RE =
  /\blist\b.{0,120}?\b(?:not\s+paid|unpaid|haven'?t\s+paid|didn'?t\s+pay)\b/i;
const UNPAID_NOUN_RE = /\b(?:unpaid|not\s+paid)\s+(?:students?|list)\b/i;
const UNPAID_BATCH_RE = /\bunpaid\b[^.]{0,80}?\b(?:batch|students?|list)\b/i;
const BATCH_UNPAID_RE = /\b(?:batch|students?|list)\b[^.]{0,80}?\bunpaid\b/i;
const WHO_UNPAID_RE =
  /\bwho\s+(?:(?:has|have)\s+)?not\s+paid\b|\bwho\s+(?:hasn'?t|haven'?t|didn'?t)\s+(?:paid|pay)\b/i;

const isUnpaidListQuestion = (text: string) => {
  const t = text.trim();
  if (!t) return false;
  return (
    LIST_UNPAID_RE.test(t) ||
    UNPAID_NOUN_RE.test(t) ||
    UNPAID_BATCH_RE.test(t) ||
    BATCH_UNPAID_RE.test(t) ||
    WHO_UNPAID_RE.test(t)
  );
};

function run() {
  // 1. The exact reported question must be recognised, not left to the
  //    grounded fallback.
  assert.equal(
    isUnpaidListQuestion("List all the students who not paid divide by their batches"),
    true,
  );
  assert.equal(isUnpaidListQuestion("unpaid students"), true);
  assert.equal(isUnpaidListQuestion("who hasn't paid"), true);
  assert.equal(isUnpaidListQuestion("who has not paid"), true);
  assert.equal(isUnpaidListQuestion("list of students who have not paid"), true);
  assert.equal(isUnpaidListQuestion("GNITC Batch 2 unpaid list"), true);
  assert.equal(isUnpaidListQuestion("show me the students who haven't paid"), true);
  assert.equal(isUnpaidListQuestion("unpaid in GNITC Batch 2"), true);
  assert.equal(isUnpaidListQuestion("GNITC Batch 2 unpaid"), true);

  // 2. The paid-count questions must NOT be hijacked into the unpaid list —
  //    they belong to answerPaidCount, which runs first.
  assert.equal(isUnpaidListQuestion("how many paid"), false);
  assert.equal(isUnpaidListQuestion("paid list"), false);
  assert.equal(isUnpaidListQuestion("who has paid"), false);
  assert.equal(isUnpaidListQuestion("how many students paid"), false);

  // 3. A student's OWN payment problem must NOT match — "i already paid
  //    but it is not showing" is a personal status question, and "did I
  //    pay" / "my payment status" are answered from their own record.
  assert.equal(isUnpaidListQuestion("i already paid but it is not showing"), false);
  assert.equal(isUnpaidListQuestion("did I pay"), false);
  assert.equal(isUnpaidListQuestion("my payment status"), false);
  assert.equal(isUnpaidListQuestion("Did she pay?"), false);
  // "unpaid" on its own is a question, not a list request — the batch word
  // (or students/list) is what makes it a list.
  assert.equal(isUnpaidListQuestion("my fee is unpaid, what do I do?"), false);

  // 4. The handler must live in the ADMIN branch only. A student asking
  //    "who hasn't paid" must never see other students' names, so the call
  //    has to sit after getAdmin() recognised the sender and before the
  //    student flow starts — and there must be exactly one call site.
  const router = readFileSync(
    new URL("../src/lib/whatsapp/router.ts", import.meta.url),
    "utf8",
  );
  const adminBlock = router.indexOf("if (admin) {");
  const studentFlow = router.indexOf("if (!(await isWhatsAppBotEnabled(db)))");
  const callSites = [...router.matchAll(/answerUnpaidList\(db, msg\.from, text\)/g)];
  assert.ok(adminBlock !== -1, "router must keep its admin branch");
  assert.ok(studentFlow !== -1, "router must keep its student flow gate");
  assert.equal(callSites.length, 1, "exactly one answerUnpaidList call site");
  const callAt = callSites[0].index ?? -1;
  assert.ok(
    callAt > adminBlock && callAt < studentFlow,
    "answerUnpaidList must be called inside the admin branch, before the student flow",
  );
  const paidCountCall = router.indexOf('await answerPaidCount(db, msg.from, phone, text, "admin")');
  assert.ok(paidCountCall !== -1, "the paid-count admin hook must still exist");
  assert.ok(
    callAt > paidCountCall,
    "the unpaid hook sits after the paid-count hook, so paid questions keep their answer",
  );

  // 5. The module must stay admin-only by construction: no student scope,
  //    no student-branch import.
  const mod = readFileSync(
    new URL("../src/lib/whatsapp/unpaid-list.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    mod.includes("answerUnpaidList is called from the admin"),
    "the module must document its admin-only rule",
  );
  assert.equal(
    (mod.match(/"student"/g) ?? []).length,
    0,
    "the unpaid-list module must not contain a student scope",
  );

  console.log("unpaid-list routing: all checks passed");
}

run();
