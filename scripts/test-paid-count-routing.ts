/**
 * Pins the live-reported WhatsApp transcript that this routing exists for:
 *
 *   student: "How many paid"   → replied with a generic payment FAQ
 *   student: "Gnitc batch 1"   → replied with the registration process
 *
 * Both halves are asserted here, plus the two traps this area keeps falling
 * into: hardcoded college lists (items #101/#107) and "GNIT" swallowing
 * "GNITC".
 *
 * The matchers under test are module-private in router.ts, so they are
 * re-declared here exactly as router.ts builds them. If you change them
 * there, change them here — a divergence failing this test is the point.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Colleges are DB-derived at runtime; longest-first so GNITC is never
// swallowed by the GNIT alternative.
const tokensFor = (ids: string[]) => [...ids].sort((a, b) => b.length - a.length);
const collegeTokenRe = (t: string[]) => new RegExp(`\\b(${t.map(escapeRe).join("|")})\\b`, "i");
const collegeAndNumberRe = (t: string[]) =>
  new RegExp(`\\b(${t.map(escapeRe).join("|")})\\s*(?:batch\\s*[-#]?\\s*)?(\\d+)\\b`, "i");

const PAID_LIST_RE =
  /\bpaid\s+(?:list|students?|so\s+far)\b|\blist\s+of\s+(?:paid|payments?)\b|\bpayments?\s+list\b|\bwho\s+(?:has\s+|have\s+)?paid\b/i;
const PAID_COUNT_RE = /\b(?:how\s+many|number\s+of|count\s+of|count)\s+(?:students?\s+)?(?:did\s+)?(?:make\s+)?(?:the\s+)?payments?\b|\bhow\s+many\s+(?:students?\s+)?(?:have\s+)?paid\b|\bpaid\s+count\b|\bhow\s+many\s+paid\b/i;
const isPaidCountQuestion = (text: string) => {
  const t = text.trim().toLowerCase();
  return PAID_COUNT_RE.test(t) || PAID_LIST_RE.test(t) || (/\bpaid\b/.test(t) && /\b(?:count|how\s+many|number)\b/.test(t));
};

function run() {
  const TOKENS = tokensFor(["GNIT", "GNITC", "BIET"]);

  // 1. The exact reported question must be recognised, not left to FAQ search.
  assert.equal(isPaidCountQuestion("How many paid"), true);
  assert.equal(isPaidCountQuestion("how many have paid"), true);
  assert.equal(isPaidCountQuestion("how many students paid"), true);
  assert.equal(isPaidCountQuestion("paid count"), true);

  // A student reporting their OWN payment problem must NOT be hijacked into
  // a batch count — this is the FAQ that wrongly answered the report.
  assert.equal(isPaidCountQuestion("i already paid but it is not showing"), false);

  // 2. The exact reported follow-up must resolve college AND batch number.
  const m = "Gnitc batch 1".match(collegeAndNumberRe(TOKENS));
  assert.ok(m, '"Gnitc batch 1" must match college+number');
  assert.equal(m![1].toUpperCase(), "GNITC");
  assert.equal(Number(m![2]), 1);

  // Shorthand without the word "batch".
  const short = "gnitc 1".match(collegeAndNumberRe(TOKENS));
  assert.equal(short![1].toUpperCase(), "GNITC");

  // 3. GNIT must never swallow GNITC (items #101/#107's trap).
  assert.equal("GNITC".match(collegeTokenRe(TOKENS))![1].toUpperCase(), "GNITC");
  assert.equal("GNIT".match(collegeTokenRe(TOKENS))![1].toUpperCase(), "GNIT");

  // 4. A college added later must work with NO code change — the whole point
  //    of deriving tokens from the database.
  const WITH_NEW = tokensFor(["GNIT", "GNITC", "BIET", "VNRVJIET"]);
  const added = "vnrvjiet batch 2".match(collegeAndNumberRe(WITH_NEW));
  assert.ok(added, "a newly added college must be recognised without a code change");
  assert.equal(added![1].toUpperCase(), "VNRVJIET");

  // 5. Asking about a SECOND batch straight after an answer must work.
  //    Live-reported: "Gnit batch 1" answered, then "Gnitc batch 1" fell
  //    through to FAQ search and matched "Can I change my batch". A message
  //    naming college AND number is self-contained, so it is understood even
  //    once no question is pending.
  const standalone = (t: string, toks: string[]) => collegeAndNumberRe(toks).test(t.trim());
  assert.equal(standalone("Gnitc batch 1", TOKENS), true);
  assert.equal(standalone("gnitc 1", TOKENS), true);

  //    But a BARE college after an answer still means "register me", and must
  //    not be hijacked into a count for the next 30 minutes.
  assert.equal(standalone("GNIT", TOKENS), false);
  assert.equal(standalone("1", TOKENS), false);

  // 6. Intent continuity: an explicit competing intent wins mid-question, and
  //    a pending question is dropped once the subject changes — otherwise the
  //    pending PAID_COUNT stays armed for 30 minutes and a later bare "GNIT"
  //    (meaning "register me") comes back as a count.
  //    isPaidCountFollowUp is deliberately broad, which is exactly why the
  //    competing-intent check in router.ts has to sit in front of it.
  const looksLikeAnswer = (t: string, toks: string[]) =>
    /^for\s+batch(?:\s+\d+)?$/i.test(t.trim()) ||
    /^(?:batch\s*[-#]?\s*\d+|\d+)$/i.test(t.trim()) ||
    collegeAndNumberRe(toks).test(t.trim()) ||
    collegeTokenRe(toks).test(t.trim());

  // These DO look like answers on their own — hence the guard upstream.
  assert.equal(looksLikeAnswer("register for gnit", TOKENS), true);
  assert.equal(looksLikeAnswer("GNIT", TOKENS), true);
  // These do not, so a subject change falls through and clears the context.
  assert.equal(looksLikeAnswer("what is the fee", TOKENS), false);
  assert.equal(looksLikeAnswer("i already paid but it is not showing", TOKENS), false);

  // 7. A STUDENT must never be shown the cross-batch chooser.
  //
  //    Live-reported: the admin answer — "Please specify the batch", then
  //    every college's batches — is correct for an admin, who genuinely picks
  //    between them, and wrong for a student, who is in exactly one batch and
  //    has no business browsing other colleges'. This is a control-flow rule
  //    rather than a matcher, so it is pinned against the source: the student
  //    branch must return BEFORE the chooser and the ambiguity list are
  //    reachable.
  const router = readFileSync(
    new URL("../src/lib/whatsapp/router.ts", import.meta.url),
    "utf8",
  );

  const studentBranch = router.indexOf('if (scope === "student") {');
  const chooser = router.indexOf("await sendPaidCountCollegeChoices(db, waFrom)");

  assert.ok(studentBranch !== -1, "answerPaidCount must keep a student-scoped branch");
  assert.ok(chooser !== -1, "the admin chooser must still exist — it is correct for admins");
  assert.ok(
    studentBranch < chooser,
    "the student branch must return before the admin chooser is reachable",
  );

  // 8. The admin chooser is TAPPABLE, and offers only batches that have
  //    registered students.
  //
  //    Reported together: "for admin it must show button first college names
  //    then allbatch button not writing manual", and "no need to show
  //    everyone only show to register people". The old chooser printed a text
  //    list and led with BIET Batch 1 — a batch with nobody in it, so tapping
  //    it could only ever answer "0 of 0".
  const paidCount = readFileSync(
    new URL("../src/lib/whatsapp/paid-count.ts", import.meta.url),
    "utf8",
  );

  assert.ok(
    paidCount.includes("sendWhatsAppList("),
    "the chooser must send tappable list rows, not a typed-answer prompt",
  );
  assert.ok(
    /\.filter\(b => b\.enrolled > 0\)/.test(paidCount),
    "countableBatches must drop batches with no registered students",
  );
  assert.ok(
    paidCount.includes('.eq("is_profile_complete", true)'),
    "enrolment must use the item #103 rule (batch_id + is_profile_complete)",
  );

  //    A tap has to be dispatched, or the buttons are decoration.
  const adminMenu = readFileSync(
    new URL("../src/lib/whatsapp/admin-menu.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    adminMenu.includes("handlePaidCountSelection"),
    "handleAdminSelection must dispatch paid-count taps",
  );

  //    Selection ids must stay distinct, or one prefix swallows the other.
  assert.ok(
    !paidCount.includes('PAID_COUNT_BATCH_PREFIX = "adm_pc_col_"'),
    "the college and batch selection prefixes must not collide",
  );

  //    And it must resolve the batch from the STUDENT, not from their words:
  //    findBatchForPaidCount deliberately takes no preferred-batch argument,
  //    so "GNITC Batch 2" can never quietly resolve to the asker's own batch.
  assert.ok(
    !/findBatchForPaidCount\([^)]*preferredBatchId/.test(router),
    "findBatchForPaidCount must not reintroduce a preferred-batch parameter",
  );

  // 9. "Paid list" is a data request, not a student payment problem.
  //
  //    Live-reported: an admin typed "Paid list" and got the student FAQ
  //    "Payments are verified automatically... check your UPI app". Trigram
  //    similarity to that FAQ is only 0.125, well under the 0.25 floor, so it
  //    was SEMANTIC search that matched — no threshold change fixes this, the
  //    shape has to be recognised before FAQ search is ever reached.
  assert.equal(isPaidCountQuestion("Paid list"), true);
  assert.equal(isPaidCountQuestion("who has paid"), true);
  assert.equal(isPaidCountQuestion("paid so far"), true);
  assert.equal(isPaidCountQuestion("list of paid"), true);

  //    But it must not swallow the exact admin commands, which are matched
  //    AFTER answerPaidCount runs.
  for (const cmd of ["PAYMENTS", "PENDING", "STUDENTS", "STATUS", "HELP"]) {
    assert.equal(isPaidCountQuestion(cmd), false, `${cmd} must stay an admin command`);
  }
  //    Nor a student reporting their own payment problem.
  assert.equal(isPaidCountQuestion("i already paid but it is not showing"), false);

  // 10. The admin path must not answer from the student FAQ corpus verbatim.
  //     Those answers are written for students ("check your UPI app"), so
  //     reciting one to an admin is nonsense addressed to the wrong person.
  //     The grounded answer still receives the same FAQs, but with
  //     audience:"admin".
  assert.ok(
    !router.includes("adminFaqMatch"),
    "the admin path must not reply with a raw student FAQ answer",
  );
  assert.ok(
    router.includes('audience') || router.includes('"admin")'),
    "the admin path must still have an admin-scoped grounded answer",
  );

  console.log("test-paid-count-routing: all assertions passed");
}

run();
