// The batches overview's "who has paid" line (src/lib/batch-paid-line.ts).
// Run: node scripts/test-batch-paid-line.cjs
const path = require("path");
const jiti = require("jiti")(__filename, { alias: { "@": path.join(__dirname, "..", "src") }, interopDefault: true });
const { paidLine } = jiti("@/lib/batch-paid-line");

let failed = 0;
function t(name, ok) { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); }

const closed = (paid, notPaid) => ({ status: "closed", student_count: paid, paid_count: paid, not_paid_count: notPaid });

t("closed, everyone paid → calm green line", (() => { const l = paidLine(closed(34, 0)); return l && l.text === "All paid — nobody waiting" && l.color === "#166534"; })());
t("closed, empty → says empty, still green", (() => { const l = paidLine(closed(0, 0)); return l && l.text === "Empty — nobody waiting" && l.color === "#166534"; })());
t("closed with unpaid people left → red, names the count", (() => { const l = paidLine(closed(34, 24)); return l && l.text === "24 not paid — still in this closed batch" && l.color === "#b91c1c"; })());
t("a single unpaid person left is still flagged", (() => { const l = paidLine(closed(10, 1)); return l && /^1 not paid/.test(l.text) && l.color === "#b91c1c"; })());
t("closed batch counts unfinished registrations too (they are stranded as well)", (() => {
  const l = paidLine({ status: "closed", student_count: 24, paid_count: 24, not_paid_count: 3 });
  return l && l.text === "3 not paid — still in this closed batch" && l.color === "#b91c1c";
})());
t("active batch → plain tally, grey (nothing is stranded in a live batch)", (() => {
  const l = paidLine({ status: "active", student_count: 19, paid_count: 0, not_paid_count: 19 });
  return l && l.text === "0 paid · 19 not paid" && l.color === "#6b7280";
})());
t("active batch adds up to the printed 'N students' even with unfinished registrations", (() => {
  // 24 finished registrations, 1 paid; 38 more people opened the link and never finished.
  const l = paidLine({ status: "active", student_count: 24, paid_count: 1, not_paid_count: 61 });
  return l && l.text === "1 paid · 23 not paid";
})());
t("active batch never shouts, even with many unpaid", (() => {
  const l = paidLine({ status: "active", student_count: 62, paid_count: 1, not_paid_count: 61 });
  return l && l.color === "#6b7280";
})());
t("active tally can never go negative", (() => {
  const l = paidLine({ status: "active", student_count: 2, paid_count: 5, not_paid_count: 0 });
  return l && l.text === "5 paid · 0 not paid";
})());
t("payments could not be read → no line at all (never a false 'nobody waiting')", paidLine({ status: "closed", student_count: 3, paid_count: null, not_paid_count: null }) === null);
t("only one of the two unknown → no line", paidLine({ status: "closed", student_count: 5, paid_count: 5, not_paid_count: null }) === null && paidLine({ status: "closed", student_count: 5, paid_count: null, not_paid_count: 0 }) === null);
t("archived behaves like closed", (() => { const l = paidLine({ status: "archived", student_count: 5, paid_count: 3, not_paid_count: 2 }); return l && l.color === "#b91c1c"; })());
t("full / pending_setup behave like closed (not live)", (() => {
  const a = paidLine({ status: "full", student_count: 3, paid_count: 3, not_paid_count: 0 });
  const b = paidLine({ status: "pending_setup", student_count: 0, paid_count: 0, not_paid_count: 0 });
  return a && a.color === "#166534" && b && b.text === "Empty — nobody waiting";
})());

if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
console.log("\nall passed");
