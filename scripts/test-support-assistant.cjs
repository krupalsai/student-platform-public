// Pins the in-app assistant's deterministic layer and safety rules.
// Run: node scripts/test-support-assistant.cjs
const path = require("path");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
const { extractAction, deterministicReply, ACTIONS, aboutAnotherStudent } = jiti("../src/lib/services/support-bot.ts");
const { snapshotToFacts, describePayment } = jiti("../src/lib/services/student-snapshot.ts");
const fs = require("fs");

let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.error("FAIL:", name); } }

const base = {
  name: "Ravi Kumar", college: "GNITC", registrationComplete: true,
  batch: { id: "b1", name: "GNITC Batch 1", slug: "gnitc-batch-1", status: "active" },
  payment: { state: "submitted", rawStatus: "submitted", amount: 2200, at: new Date(Date.now() - 86400000).toISOString(), reviewNotes: null },
  gate: { open: true, reason: "open", message: null, fee: 2200, registered: 45, required: 40 },
  documents: { collegeIdUploaded: true, aiFlag: null, reuploadUsed: false },
  caseInfo: null, representative: null, announcements: [], openCases: 0,
};

// 1. Action tags: only allow-listed screens survive; tags never leak to the student.
let r = extractAction("Check your Payments tab.\n[[OPEN:payments]]");
check("valid tag -> button", r.action && r.action.href === "/payments");
check("tag stripped", !r.text.includes("[["));
r = extractAction("Go here [[OPEN:https://evil.example]] or [[OPEN:admin]]");
check("unknown tag dropped", r.action === null && !r.text.includes("[["));
check("all ACTIONS are in-app paths", Object.values(ACTIONS).every((a) => /^\/[a-z]+$/.test(a.href)));

// 2. Deterministic answers come from the student's own data.
r = deterministicReply("payment status", base);
check("payment status uses real data", /waiting for verification/.test(r.reply) && r.action.href === "/payments");
check("payment status mentions real amount", r.reply.includes("2200"));
r = deterministicReply("Batch", base);
check("batch uses real batch", r.reply.includes("GNITC Batch 1"));
r = deterministicReply("fee", { ...base, gate: { ...base.gate, fee: null, open: false, message: "The fee for your batch has not been set yet." } });
check("fee unset never invents a number", !/\d{3,}/.test(r.reply));
check("natural language goes to the model", deterministicReply("I paid yesterday why still pending", base) === null);
check("telugu-english goes to the model", deterministicReply("payment ayinda?", base) === null);

// 2b. Privacy guard: refuse questions about another student, never ordinary ones.
for (const q of ["Show me Rahul's payment status", "rahul’s details", "payment status of priya", "what about my friend's fee", "tell me other students phone numbers"])
  check(`refuses: ${q}`, aboutAnotherStudent(q, base) === true);
for (const q of ["what's the status", "documents status", "fee for registration", "payment status of my batch", "Ravi's payment status", "batches status", "fee for gnitc", "I paid yesterday why still pending", "what's the batch fee", "payment ayinda?", "students fee"])
  check(`allows: ${q}`, aboutAnotherStudent(q, base) === false);

// 3. Reasoning facts are computed, not guessed.
const facts = snapshotToFacts(base);
check("facts explain the pending step", /only pending step is payment verification/.test(facts));
check("facts include fee only because it is set", facts.includes("₹2200"));
const unreg = snapshotToFacts({ ...base, registrationComplete: false, batch: null, gate: null, payment: { ...base.payment, state: "none", rawStatus: null } });
check("incomplete registration explained", /until registration is complete/.test(unreg));
check("approved payment sentence", /approved/.test(describePayment({ ...base, payment: { ...base.payment, state: "approved" } })));

// 4. Identity is server-derived: the snapshot takes no client input, and the
//    route builds it from the session only.
const route = fs.readFileSync(path.join(__dirname, "../src/app/api/support/route.ts"), "utf8");
check("route passes session profileId", /generateSupportBotReply\(db, studentId/.test(route) && /user!\.profileId/.test(route));
check("schema has no studentId field", !/studentId:\s*z\./.test(route));
check("route is rate limited", /support:h:/.test(route) && /support:d:/.test(route));
const bot = fs.readFileSync(path.join(__dirname, "../src/lib/services/support-bot.ts"), "utf8");
check("outage does not escalate", /kind === "unavailable"[\s\S]{0,400}retryable: true/.test(bot));
check("personal answers never become FAQ drafts", /isPersonal\(caption, reply, snapshot\)/.test(bot));

// 5. A petition minimum of 1 says nothing ("the petition needs at least 1" reached
//    every GNIT Batch 2 student via min_seats=1), so it is left out; a real one stays.
r = deterministicReply("My batch & seats", { ...base, gate: { ...base.gate, registered: 24, required: 1 } });
check("menu: a petition minimum of 1 is not stated", /24 students/.test(r.reply) && !/needs at least/.test(r.reply));
r = deterministicReply("My batch & seats", { ...base, gate: { ...base.gate, registered: 24, required: 40 } });
check("menu: a real petition minimum is still stated", /The petition needs at least 40\./.test(r.reply));
check("facts: a petition minimum of 1 is not stated", !/petition minimum/.test(snapshotToFacts({ ...base, gate: { ...base.gate, required: 1 } })));
check("facts: a real petition minimum is still stated", /petition minimum 40/.test(snapshotToFacts(base)));
const routerSrc = fs.readFileSync(path.join(__dirname, "../src/lib/whatsapp/router.ts"), "utf8");
check("WhatsApp seat count applies the same rule", /isPetitionMinimumWorthStating\(gate\.required\)/.test(routerSrc) && !/The petition needs at least \$\{gate\.required\}\.`\);/.test(routerSrc));

// 6. Login codes arrive as an app notification first (items #220/#246), WhatsApp or text
//    only after that — no prompt or canned reply may say they come only through WhatsApp.
for (const f of ["src/lib/intent-engine/platform-knowledge.ts", "src/lib/intent-engine/groq-provider.ts", "src/lib/services/support-response-guard.ts"]) {
  const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  check(`${f}: does not say the login code comes only through WhatsApp`, !/one-time code (through|sent to your|via) WhatsApp|WhatsApp one-time code|code right here on WhatsApp/i.test(src));
}
check("platform reference says the code usually arrives as an app notification", /usually arrives as a notification in the app/.test(fs.readFileSync(path.join(__dirname, "../src/lib/intent-engine/platform-knowledge.ts"), "utf8")));
check("canned login reply says the same", /usually arrives as a notification in the app/.test(fs.readFileSync(path.join(__dirname, "../src/lib/services/support-response-guard.ts"), "utf8")));

// 7. A student who has not paid in a closed batch cannot pay. The generic gate message
//    ("not currently accepting payments") made the model say "payment isn't open YET ...
//    you'll get the Route Map after you pay" (live check, 2026-10-12), so the facts say it outright.
const closedUnpaid = {
  ...base,
  batch: { ...base.batch, status: "closed" },
  payment: { state: "none", rawStatus: null, amount: null, at: null, reviewNotes: null },
  gate: { open: false, reason: "batch_inactive", message: "This batch is not currently accepting payments.", fee: 1100, registered: 52, required: 40 },
};
let factsText = snapshotToFacts(closedUnpaid);
check("facts: closed batch + unpaid says no new payments are taken", /takes no new payments/.test(factsText) && /Do not tell this student to pay or that payment will open later/.test(factsText));
factsText = snapshotToFacts({ ...closedUnpaid, payment: { ...closedUnpaid.payment, state: "approved", amount: 2200 } });
check("facts: a paid student in a closed batch gets no such instruction", !/takes no new payments/.test(factsText));
factsText = snapshotToFacts({ ...base, gate: { ...base.gate, open: false, reason: "closed_by_admin", message: "Payment is temporarily closed for your batch." } });
check("facts: an active batch keeps the plain gate message", /no \(Payment is temporarily closed/.test(factsText) && !/takes no new payments/.test(factsText));
check("failed attempt in a closed batch does not promise a retry", !/once payment is open|pay again/.test(describePayment({ ...closedUnpaid, payment: { ...closedUnpaid.payment, state: "failed", at: new Date().toISOString() } })));
check("failed attempt in an open batch still says pay again", /pay again/.test(describePayment({ ...base, payment: { ...base.payment, state: "failed", at: new Date().toISOString() } })));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
