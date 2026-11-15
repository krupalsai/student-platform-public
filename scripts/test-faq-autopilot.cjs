// Item #222 — learned answers publish themselves after an automatic review.
const assert = require("node:assert");
const fs = require("node:fs");
const jiti = require("jiti")(__filename, { alias: { "@": require("path").join(__dirname, "../src") } });
const { hardRejectReason } = jiti("../src/lib/services/faq-autopilot.ts");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const good = "You can register by opening the registration link the bot sends you and filling in your details in the Student App.";
ok(hardRejectReason("How do I register for the petition?", good) === null, "a generic, complete answer goes to the judge");
ok(hardRejectReason("I did not received", good), "fragment rejected");
ok(hardRejectReason("Can you check that", good), "fragment rejected (short)");
ok(hardRejectReason("How do I register for the petition?", "Since specific timelines depend on"), "cut-off answer rejected");
ok(hardRejectReason("What is the fee for my batch?", "The fee is ₹2200, paid in the Student App once the batch fills."), "amount rejected (rule 8)");
ok(hardRejectReason("How do I register for the petition?", "Hey Azhar, you just need to open the link and fill the form today."), "personal greeting rejected");
ok(hardRejectReason("Is my payment done already?", "Your payment is approved, you can see it on the Payments tab now."), "own-record answer rejected");
ok(hardRejectReason("What happened at the court hearing?", "The lawyer will share the update with your batch soon."), "court topic rejected");
ok(hardRejectReason("When will I get my certificates?", "Certificates are released after the process completes at the college."), "timeline rejected");

ok(hardRejectReason("Any update regarding petition for Batch 1?", "The petition moves forward once the batch hits the required headcount. Since you're already registered and your payment is confirmed, check the Route Map."), "situational answer rejected");
ok(hardRejectReason("How to re-upload my ID?", "Which file do you need to re-upload – the college ID photo or the payment screenshot?"), "clarifying-question answer rejected");
const src = fs.readFileSync(__dirname + "/../src/lib/services/faq-autopilot.ts", "utf8");
ok(/\.eq\("source", "ai_draft"\)/.test(src), "only AI drafts are ever touched");
ok(/verdict: "skip"/.test(src) && /if \(v\.verdict === "skip"\)/.test(src), "no reviewer → nothing published (fail closed)");
ok(/PLATFORM_REFERENCE/.test(src), "judged against the platform facts");
const faq = fs.readFileSync(__dirname + "/../src/lib/services/faq.ts", "utf8");
ok(/enabled: false, source: "ai_draft"/.test(faq), "saveDraftFaq marks rows as AI drafts");
const sw = fs.readFileSync(__dirname + "/../src/app/api/cron/self-watch/route.ts", "utf8");
ok(/reviewDraftFaqs\(db\)/.test(sw), "self-watch runs the autopilot");
console.log(`faq-autopilot: ${n} assertions passed`);
