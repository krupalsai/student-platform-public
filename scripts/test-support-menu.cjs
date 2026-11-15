// Pins the Support menu: every topic is answered instantly from the student's
// own data (no model), with only in-app buttons, and menu taps are exempt from
// the typed-message limit. Run: node scripts/test-support-menu.cjs
const path = require("path");
const fs = require("fs");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
const { deterministicReply, menuReply } = jiti("../src/lib/services/support-bot.ts");
const { SUPPORT_MENU_TOPICS, asMenuTopic } = jiti("../src/lib/support-menu.ts");

let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.error("FAIL:", name); } }

const base = {
  name: "Ravi Kumar", college: "GNITC", registrationComplete: true,
  batch: { id: "b1", name: "GNITC Batch 1", slug: "gnitc-batch-1", status: "active" },
  payment: { state: "none", rawStatus: null, amount: null, at: null, reviewNotes: null },
  gate: { open: true, reason: "open", message: null, fee: 2200, registered: 45, required: 40 },
  documents: { collegeIdUploaded: true, aiFlag: null, reuploadUsed: false },
  caseInfo: { number: "WP 12345 / 2026", status: "PENDING", nextHearing: "2026-10-20", checkedAt: null },
  representative: { name: "Sai", phone: null }, announcements: [], openCases: 0,
};

for (const t of SUPPORT_MENU_TOPICS) {
  const r = deterministicReply(t, base);
  check(`${t}: answered without a model`, r && typeof r.reply === "string" && r.reply.length > 10);
  check(`${t}: never escalates`, r && r.escalated === false);
  check(`${t}: button is in-app only`, !r.action || /^\/[a-z]+$/.test(r.action.href));
  check(`${t}: exact label is a menu topic`, asMenuTopic(t) === t && asMenuTopic(`  ${t.toUpperCase()} `) === t);
}

check("court case shows the real number", menuReply("Court case status", base).reply.includes("WP 12345"));
check("no case yet is said plainly", /No court case number/.test(menuReply("Court case status", { ...base, caseInfo: null }).reply));
check("fee unset never invents a number", !/\d{3,}/.test(menuReply("Fee & how to pay", { ...base, gate: { ...base.gate, fee: null, open: false } }).reply));
check("route map locked until paid", /unlocks once your payment is approved/.test(menuReply("Certificate steps", base).reply));
check("closed batch: no correction button", menuReply("Correct my details", { ...base, batch: { ...base.batch, status: "closed" } }).action === null);
check("free text is not a menu topic", asMenuTopic("my payment is stuck pls help") === null);

const route = fs.readFileSync(path.resolve(__dirname, "../src/app/api/support/route.ts"), "utf8");
check("menu taps skip the typed limit", (route.match(/isMenuTap \? null : await overLimit/g) || []).length === 2);

console.log(`test-support-menu: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
