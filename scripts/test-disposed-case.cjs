// Pins how a DISPOSED court case is described (daily review 2026-10-05):
// outcome stated, no stale "next listing", final copy location = Home, and
// never a date for when the court will upload it.
// Run: node scripts/test-disposed-case.cjs
const path = require("path");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
const { menuReply } = jiti("../src/lib/services/support-bot.ts");
const { snapshotToFacts, caseOutcomeLine } = jiti("../src/lib/services/student-snapshot.ts");

let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.error("FAIL:", name); } }

const disposedCase = { number: "WP 12345 / 2026", status: "DISPOSED", nextHearing: null, checkedAt: null,
  disposedOn: "28-09-2026", disposalType: "ALLOWED NO COSTS", finalOrderAvailable: false };
const s = {
  name: "Ravi", college: "GNIT", registrationComplete: true,
  batch: { id: "b1", name: "GNIT Batch 1", slug: "gnit-batch-1-2", status: "closed" },
  payment: { state: "approved", rawStatus: "approved", amount: 2200, at: null, reviewNotes: null },
  gate: null, documents: { collegeIdUploaded: true, aiFlag: null, reuploadUsed: false },
  caseInfo: disposedCase, representative: null, announcements: [], openCases: 0,
};

const r = menuReply("Court case status", s);
check("menu states disposal", /Disposed on 28-09-2026/.test(r.reply));
check("menu says allowed", /ALLOWED/.test(r.reply));
check("menu: no stale next listing", !/Next listing/i.test(r.reply));
check("menu: copy not uploaded yet", /not uploaded the final order copy/.test(r.reply));
check("menu points to Home, not Batch/Messages tab", /Home screen/.test(r.reply) && !/Messages tab|Batch tab/.test(r.reply));
check("menu: no upload date promised", /cannot say when/.test(r.reply));

const facts = snapshotToFacts(s);
check("facts carry outcome", /Court case outcome: Disposed on 28-09-2026/.test(facts));
const courtLine = facts.split("\n").find((l) => l.startsWith("Court case:")) || "";
check("facts: court case on Home, not Batch tab", /Home screen/.test(courtLine) && !/Batch tab/.test(courtLine));

const avail = caseOutcomeLine({ ...disposedCase, finalOrderAvailable: true });
check("available copy points to Orders & Judgments", /is on the court portal/.test(avail));
check("partly allowed not called a full win", !/petitioners' favour/.test(caseOutcomeLine({ ...disposedCase, disposalType: "PARTLY ALLOWED" })));
check("dismissed not called a win", !/favour/.test(caseOutcomeLine({ ...disposedCase, disposalType: "DISMISSED" })));

const pending = menuReply("Court case status", { ...s, caseInfo: { ...disposedCase, status: "PENDING", disposedOn: null, disposalType: null, nextHearing: "2026-10-20" } });
check("pending still shows next listing", /Next listing: 2026-10-20/.test(pending.reply));

console.log(`test-disposed-case: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
