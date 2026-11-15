// Daily review 2026-10-15. GNITC Batch 1's case was DISPOSED OF NO COSTS on 13 Oct; the
// court gives order dates as ISO ("2026-10-13") but the disposal date as "13-10-2026".
// Pins: (1) case-clarity matches the two so a published final order is seen as published;
// (2) the assistant words "disposed of no costs" without claiming a win and answers
// "did we win?" from the record; (3) a model reply that claims an outcome the record
// does not show is replaced (real thread 2026-10-08: "disposed of in your favour" for a
// batch with no case on file).
// Run: node scripts/test-case-outcome.cjs
const fs = require("fs");
const path = require("path");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
const clarity = jiti("../src/lib/case-clarity.ts");
const guard = jiti("../src/lib/case-outcome-guard.ts");
const { deterministicReply, menuReply, outcomeGuardedReply } = jiti("../src/lib/services/support-bot.ts");
const { caseOutcomeLine, caseStatusText, snapshotToFacts } = jiti("../src/lib/services/student-snapshot.ts");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) pass++; else { fail++; console.error("FAIL:", name); } };

// ---- 1. case-clarity: both date shapes the court uses -------------------------------------------
t("formatCourtDate dd-mm-yyyy", clarity.formatCourtDate("13-10-2026") === "13 Oct 2026");
t("formatCourtDate dd/mm/yyyy", clarity.formatCourtDate("13/10/2026") === "13 Oct 2026");
t("formatCourtDate ISO", clarity.formatCourtDate("2026-10-13") === "13 Oct 2026");
t("formatCourtDate ISO with time", clarity.formatCourtDate("2026-10-13T00:00:00") === "13 Oct 2026");
t("formatCourtDate unparsable stays as given", clarity.formatCourtDate(" soon ") === "soon");
t("formatCourtDate null", clarity.formatCourtDate(null) === null && clarity.formatCourtDate("") === null);

const disposed = (orders, extra = {}) => ({
  status: "DISPOSED", listingDate: "13/10/2026", filingDate: "28/09/2026", registrationDate: "28/09/2026",
  disposalDate: "13-10-2026", disposalType: "DISPOSED OF NO COSTS", judges: null, purpose: null,
  latestOrder: { date: "2026-10-12", type: "DAILY ORDER" }, orders, petitionerCount: 34, ...extra,
});
const order = (date, url) => ({ date, type: "DAILY ORDER", judge: null, url });
// the real data: orders up to the 12th, none for the disposal date yet
t("no order for the disposal date -> pending", clarity.writtenOrderState(disposed([order("2026-10-09", "https://x/a.pdf"), order("2026-10-12", "https://x/b.pdf")])).kind === "pending");
// the bug: an order dated the disposal day in ISO form was never matched
t("ISO order on the disposal day -> published", clarity.writtenOrderState(disposed([order("2026-10-13", "https://x/c.pdf")])).kind === "published");
t("ISO order on the disposal day without a PDF -> listed-no-pdf", clarity.writtenOrderState(disposed([order("2026-10-13", null)])).kind === "listed-no-pdf");
t("dd/mm order date still matches", clarity.writtenOrderState(disposed([order("13/10/2026", "https://x/c.pdf")])).kind === "published");
t("a pending case has no written-order state", clarity.writtenOrderState(disposed([], { status: "PENDING" })) === null);
const pendingStep = clarity.writtenOrderStep(disposed([]));
t("pending step says awaiting publication", pendingStep.state === "pending" && /Awaiting publication/.test(pendingStep.note));
const publishedStep = clarity.writtenOrderStep(disposed([order("2026-10-13", "https://x/c.pdf")]));
t("published step is done and links the PDF", publishedStep.state === "done" && publishedStep.orderUrl === "https://x/c.pdf");
const kuPending = clarity.knownUnknown(disposed([]));
t("not published: the unknown list says so", kuPending.unknown.some((x) => /not published yet/.test(x)));
const kuPublished = clarity.knownUnknown(disposed([order("2026-10-13", "https://x/c.pdf")]));
t("published: nothing says it is unpublished", kuPublished.unknown.length === 0 && kuPublished.known.some((x) => /written order is published/.test(x)));
t("freshness reads an ISO latest order", clarity.freshnessLine({ ...disposed([]), disposalDate: null }) === "No new update since 12 Oct 2026");
t("freshness prefers the disposal date", clarity.freshnessLine(disposed([])) === "No new update since 13 Oct 2026");

// ---- 2. the wording never claims a win the label does not say ----------------------------------
const noCosts = clarity.disposalMeaning("DISPOSED OF NO COSTS");
t("disposed-of-no-costs: not a win", !/favou?r|allowed|won\b/i.test(noCosts.replace("who won", "")));
t("disposed-of-no-costs: says it does not tell who won", /doesn't tell us who won/.test(noCosts));
t("disposed-of-no-costs: stays true after the order is published", !/not published/i.test(noCosts));
t("allowed no costs: a win", /ruled in favor of the petition/.test(clarity.disposalMeaning("ALLOWED NO COSTS")));
t("partly allowed: not a full win", /partly in favor/.test(clarity.disposalMeaning("PARTLY ALLOWED")));
t("dismissed: rejected", /rejected the petition/.test(clarity.disposalMeaning("DISMISSED")));

const gnitc = { number: "WP 12345 / 2026", status: "DISPOSED", nextHearing: null, checkedAt: null, disposedOn: "13-10-2026", disposalType: "DISPOSED OF NO COSTS", finalOrderAvailable: false };
const gnit = { ...gnitc, disposedOn: "28-09-2026", disposalType: "ALLOWED NO COSTS" };
const pending = { number: "WP 12346 / 2026", status: "PENDING", nextHearing: "20/10/2026", checkedAt: null, disposedOn: null, disposalType: null, finalOrderAvailable: false };
const line = caseOutcomeLine(gnitc);
t("outcome line: date, label, meaning", /Disposed on 13-10-2026 \(DISPOSED OF NO COSTS\)\./.test(line) && /without ordering either side to pay court costs/.test(line));
t("outcome line: never claims a win", !/ALLOWED|favou?r/i.test(line));
t("outcome line: unpublished copy is stated honestly", /has not uploaded the final order copy/.test(line) && /cannot say when/.test(line));
t("outcome line: published copy", /is on the court portal/.test(caseOutcomeLine({ ...gnitc, finalOrderAvailable: true })));
t("outcome line: allowed batch still says allowed", /ALLOWED NO COSTS/.test(caseOutcomeLine(gnit)) && /in favor of the petition/.test(caseOutcomeLine(gnit)));
t("status text: no case", /^No court case number has been recorded/.test(caseStatusText(null)));
t("status text: pending shows the next listing", /Next listing: 20\/10\/2026/.test(caseStatusText(pending)) && /Home screen/.test(caseStatusText(pending)));
t("status text: disposed", /Court status: DISPOSED\./.test(caseStatusText(gnitc)));

const snap = (caseInfo) => ({
  name: "Ravi", college: "GNITC", registrationComplete: true,
  batch: { id: "b1", name: "GNITC Batch 1", slug: "gnitc-batch-1", status: "closed" },
  payment: { state: "approved", rawStatus: "approved", amount: 1100, at: null, reviewNotes: null },
  gate: null, documents: { collegeIdUploaded: true, aiFlag: null, reuploadUsed: false },
  caseInfo, representative: null, announcements: [], openCases: 0,
});
t("facts carry the outcome with its meaning", /Court case outcome: Disposed on 13-10-2026 \(DISPOSED OF NO COSTS\)\. The court closed the case/.test(snapshotToFacts(snap(gnitc))));
t("snapshot uses the shared written-order rule, not its own date compare", /writtenOrderState\(/.test(read("src/lib/services/student-snapshot.ts")) && !/toIsoDate/.test(read("src/lib/services/student-snapshot.ts")));

// ---- 3. outcome questions are answered from the record, nothing else is hijacked ---------------
for (const q of ["Did we win?", "did we win the case", "What did the court say", "what did the High Court decide", "case result", "petition status", "what is the judgement", "what happened in the case", "is the case disposed", "Is it in our favour"]) {
  const r = deterministicReply(q, snap(gnitc));
  t(`outcome question: ${q}`, r && /Disposed on 13-10-2026/.test(r.reply) && !/ALLOWED|in favou?r/i.test(r.reply) && r.action && r.action.href === "/dashboard");
}
const noCase = deterministicReply("did we win", snap(null));
t("no case on file: says so instead of guessing", noCase && /^No court case number has been recorded/.test(noCase.reply) && !noCase.action);
const pend = deterministicReply("any court update?", snap(pending));
t("pending case: status and next listing", pend && /Court status: PENDING/.test(pend.reply) && /Next listing: 20\/10\/2026/.test(pend.reply));
for (const q of ["what is the order of the registration steps", "do me a favour and check my payment", "what is the judge's name", "how do I pay", "when will I get my certificates", "what is a petition", "my exam results"]) {
  t(`not hijacked: ${q}`, deterministicReply(q, snap(gnitc)) === null);
}
t("menu tap matches the typed answer", menuReply("Court case status", snap(gnitc)).reply === deterministicReply("what happened in the case", snap(gnitc)).reply);

// ---- 4. a model reply must not claim an outcome the record does not show -----------------------
const bad = [
  "I've checked your status. Your payment is complete and the court case has been disposed of in your favour.",   // the real 2026-10-08 reply, name removed
  "Good news — the petition was allowed.",
  "The court ruled in favor of the petition.",
  "We won the case!",
  "Congratulations — you have won the court case.",
  "The petition has been dismissed.",
  "The court case was dismissed, sorry.",
  "We lost the case.",
  "The court has directed the college to release your certificates.",
  "Following the court's order, the college must release your original certificates.",
  "It looks like a favourable order from the court.",
];
for (const text of bad) {
  t(`no record -> replaced: ${text.slice(0, 40)}`, guard.unsupportedOutcomeClaim(text, null));
  t(`disposed of no costs -> replaced: ${text.slice(0, 40)}`, guard.unsupportedOutcomeClaim(text, gnitc));
}
const fine = [
  "The court has not given a final decision yet; the next listing is on 20/10/2026.",
  "A petition is allowed to proceed only once enough students have registered.",
  "Your payment was accepted and is complete.",
  "\"No costs\" alone doesn't tell us who won — only the court's written order says what it actually directed.",
  "Open the Home screen to see the tracker and any published order.",
  "Your order of two items shows what is due.",
  "The Route Map shows the steps to get your certificates released.",
  // process explanation is conditional — the FAQ's own wording must never be replaced
  "If the High Court allows the petition and the college complies with the order, your original certificates will be released.",
  "Once the petition is allowed and the college complies, your certificates will be released.",
  "If the court rules in your favour, the college must release your certificates.",
  "The process is: the advocate files the case, a High Court order is obtained, and the order is sent to the college.",
  "Your original certificates will be released after the college receives the order.",
  // everyday wording that shares words with the claims
  "You won't be able to pay once the batch is closed.",
  "Since you lost your phone, you can still log in with a code.",
  "Your support case has been accepted by the team.",
  "The college must give you the signed No Due form before you go to the Library.",
  "We won't be able to change your roll number after registration.",
  "You won't see a court case update here until the court lists it.",
];
for (const text of fine) t(`not flagged: ${text.slice(0, 40)}`, !guard.unsupportedOutcomeClaim(text, gnitc) && !guard.unsupportedOutcomeClaim(text, null));
// supported claims pass; unsupported ones against the real label do not
t("allowed batch may be told it was allowed", !guard.unsupportedOutcomeClaim("The petition was allowed — decided in your favour.", gnit));
t("allowed batch may NOT be told it was dismissed", guard.unsupportedOutcomeClaim("The petition was dismissed.", gnit));
t("partly allowed is never a plain win", guard.unsupportedOutcomeClaim("The court ruled in your favour.", { ...gnit, disposalType: "PARTLY ALLOWED" }));
t("dismissed batch may be told it was dismissed", !guard.unsupportedOutcomeClaim("The petition was dismissed.", { ...gnitc, disposalType: "DISMISSED" }));
t("a court direction is never supported", guard.unsupportedOutcomeClaim("The court has directed the college to release the certificates.", gnit));
t("a claim in one sentence is still caught next to a conditional one", guard.unsupportedOutcomeClaim("If you have questions, ask me. The petition was allowed.", gnitc));
// the app's own deterministic texts are never flagged by the guard
for (const c of [null, pending, gnitc, gnit]) t("own text passes the guard", !guard.unsupportedOutcomeClaim(caseStatusText(c), c));
// the replacement
const swapped = outcomeGuardedReply("Your case was disposed of in your favour.", snap(gnitc));
t("replacement states the record", swapped && /Disposed on 13-10-2026/.test(swapped.reply) && !swapped.escalated && swapped.action.href === "/dashboard");
const swappedNone = outcomeGuardedReply("The court decided in your favour.", snap(null));
t("replacement with no case on file", swappedNone && /^No court case number has been recorded/.test(swappedNone.reply) && !swappedNone.action);
t("a clean reply is left alone", outcomeGuardedReply("Your payment is complete.", snap(gnitc)) === null);

// ---- 5. wiring ---------------------------------------------------------------------------------
const bot = read("src/lib/services/support-bot.ts");
t("support bot guards the model reply before saving a draft FAQ", bot.indexOf("outcomeGuardedReply(reply, snapshot)") > 0 && bot.indexOf("outcomeGuardedReply(reply, snapshot)") < bot.indexOf("saveDraftFaq(db, caption, reply)"));
t("outcome questions are answered before the model", bot.indexOf("OUTCOME_QUESTION.test(q)") > 0 && bot.indexOf("OUTCOME_QUESTION.test(q)") < bot.indexOf("generateGroundedAnswerDetailed("));
const router = read("src/lib/whatsapp/router.ts");
t("WhatsApp AI path guards its reply too", /unsupportedOutcomeClaim\(reply, caseInfo\)/.test(router) && /caseInfo = snapshot\.caseInfo/.test(router));
t("WhatsApp replacement quotes no amount", !/₹/.test(router.slice(router.indexOf("unsupportedOutcomeClaim(reply, caseInfo)"), router.indexOf("unsupportedOutcomeClaim(reply, caseInfo)") + 500)));
t("PLATFORM_REFERENCE teaches the labels", /DISPOSED OF NO COSTS" means only that the court closed the case/.test(read("src/lib/intent-engine/platform-knowledge.ts")));

console.log(`test-case-outcome: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
