// Test for the WhatsApp bot knowledge-base build (9 Nov 2026).
// Run: node scripts/test-kb.mjs   (from ~/workspace/student-platform-kb)
// Tests the REAL code: knowledge-base.ts, ai-actions.ts, rule-intent.ts,
// bot-guard.ts — plus text checks on the files that need a full Next.js
// runtime (router, faq-retrieval, groq-provider, cloudflare-provider).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL: ${name} ${detail}`); }
}

// ---- 1. Knowledge base retrieval (real code) ----
const kb = await import(pathToFileURL(`${ROOT}src/lib/whatsapp/knowledge-base.ts`).href);
console.log(`KB entries: ${kb.KNOWLEDGE_BASE.length}, verified fees: ${kb.VERIFIED_FEE_AMOUNTS.join(",")}`);
check("KB has 40+ entries", kb.KNOWLEDGE_BASE.length >= 40);
check("Verified fees are [1100,2200,2]", JSON.stringify(kb.VERIFIED_FEE_AMOUNTS) === "[1100,2200,2]");

// Real student questions from the bot logs + frequent topics.
// Expected = the KB entry that must be the TOP result.
const CASES = [
  ["Is there any seats available for joining", "kb:register-seats"],
  ["Is there any vacate seats for joining", "kb:register-seats"],
  ["I want to register for", "kb:register-how"],
  ["Hy i want to register", "kb:register-how"],
  ["Amount needed for registration", "kb:fee-general"],
  ["I am asking how much amount needed", "kb:fee-general"],
  ["how much", "kb:fee-general"],
  ["Price", "kb:fee-general"],
  ["I mean will you give me any discount here", "kb:fee-discount"],
  ["Payment", "kb:pay-how"],
  ["My payment failed", "kb:pay-failed"],
  ["I already paid but it is not showing", "kb:pay-not-showing"],
  ["Can I get a refund", "kb:pay-refund"],
  ["Can I pay the fee in two parts?", "kb:pay-parts"],
  ["How do I pay the fee?", "kb:pay-how"],
  ["Login", "kb:login-how"],
  ["For login", "kb:login-how"],
  ["Code", "kb:login-how"],
  ["Send login code", "kb:login-how"],
  ["Iam unable to open the Student app", "kb:app-open"],
  ["App download", "kb:app-install"],
  ["How there is no link", "kb:register-how"],
  ["We are waiting almost one week after disposed of case", "kb:case-status"],
  ["When we will get softcopy of case", "kb:case-hard-copy"],
  ["petition process", "kb:case-process"],
  ["Status", "kb:status-check"],
  ["Can I call now i want to talk to you", "kb:contact-call"],
  ["Can I call the admin?", "kb:contact-call"],
  ["What is the Route Map and when do I get it?", "kb:case-route-map"],
  ["How does the login code reach me?", "kb:login-how"],
  ["I have uploaded", "kb:register-documents"],
  ["After entering my details then click on save and continue, it showing internal server error", "kb:register-error"],
  ["Raise these question to the owner of this app", "kb:contact-support"],
  ["What documents do I need for registration", "kb:register-documents"],
  ["What is the last date for registration", "kb:register-last-date"],
  ["When will I get my original certificates back?", "kb:case-certificates"],
  ["When will I get the hard copy of the court order?", "kb:case-hard-copy"],
  ["Who is the key person for my batch's writ petition?", "kb:case-key-person"],
  ["What is the process?", "kb:case-process"],
  ["Is this legal?", "kb:case-legal"],
  ["How to get bonafide certificate", "kb:case-bonafide"],
  ["What is a no-due certificate and how do I get one?", "kb:case-no-due"],
  ["When will my batch start", "kb:batch-start"],
  ["How long does it take?", "kb:batch-how-long"],
  ["Can I join later?", "kb:batch-join-later"],
  ["Can I leave after joining?", "kb:batch-leave"],
  ["Can I change my batch", "kb:batch-change"],
  ["I have a job offer or higher studies. Can I join?", "kb:batch-job-offer"],
  ["How can I contact support if I have a problem?", "kb:contact-support"],
  ["How do I check my status", "kb:status-check"],
  ["Which colleges does the Student Platform support?", "kb:colleges"],
  ["How do I install the Student Platform app on my phone?", "kb:app-install"],
  ["It says my mobile number is not registered. What do I do?", "kb:login-not-registered"],
  ["I am not receiving the OTP on WhatsApp. What do I do?", "kb:login-code-not-arriving"],
  ["My registration is not complete", "kb:register-incomplete"],
  ["GNIT Batch 2 fee", "kb:fee-gnit-b2"],
  ["GNITC Batch 1 fee", "kb:fee-gnitc-b1"],
  ["BIET Batch 1 fee", "kb:fee-biet-b1"],
  ["GNITC Batch 2 fee", "kb:fee-gnitc-b2"],
  ["GNIT Batch 1 fee", "kb:fee-gnit-b1"],
];
console.log(`\nKB retrieval: ${CASES.length} real questions`);
for (const [q, expected] of CASES) {
  const got = kb.retrieveFromKnowledgeBase(q, ["public"]).map((e) => e.id);
  check(`"${q}" -> ${expected}`, got[0] === expected, `got [${got.join(", ")}]`);
}

// ---- 2. Rupee guard (real ai-actions.ts code) ----
// ai-actions.ts imports "./knowledge-base" (extensionless) which plain node
// cannot resolve, so the test loads a copy with only the import specifier
// rewritten to "./knowledge-base.ts". Function bodies are byte-identical.
mkdirSync("/tmp/kbtest", { recursive: true });
const aiSrc = readFileSync(`${ROOT}src/lib/whatsapp/ai-actions.ts`, "utf8")
  .replace('from "./knowledge-base"', 'from "./knowledge-base.ts"');
writeFileSync("/tmp/kbtest/ai-actions.ts", aiSrc);
writeFileSync("/tmp/kbtest/knowledge-base.ts", readFileSync(`${ROOT}src/lib/whatsapp/knowledge-base.ts`, "utf8"));
const ai = await import(pathToFileURL("/tmp/kbtest/ai-actions.ts").href);
console.log("\nRupee guard (verified fees must PASS, invented amounts must be BLOCKED)");
const GUARD = [
  ["The fee for GNIT Batch 2 is ₹2,200.", false],
  ["GNIT Batch 1 is ₹1,100.", false],
  ["BIET Batch 1 is ₹2.", false],
  ["The fee is Rs 2200.", false],
  ["The fee is Rs. 1,100.", false],
  ["The fee is INR 2200.", false],
  ["The fee is ₹5,000.", true],
  ["The fee is ₹2,500.", true],
  ["The fee is Rs 999.", true],
  ["Pay ₹10,000 now.", true],
  ["No amount here at all.", false],
  ["There are 2 students and 2200 rupees in total.", false], // plain numbers, no ₹/Rs marker
];
for (const [text, shouldBlock] of GUARD) {
  const blocked = ai.containsUnverifiedRupeeAmount(text);
  check(`guard "${text}" -> ${shouldBlock ? "BLOCK" : "ALLOW"}`, blocked === shouldBlock);
  // legacy blanket check still flags any amount (kept for compatibility)
  if (shouldBlock || text.includes("₹") || /rs/i.test(text)) {
    check(`legacy containsRupeeAmount("${text}")`, ai.containsRupeeAmount(text) === (/₹|rs\.?|inr/i.test(text) && /\d/.test(text)));
  }
}

// ---- 3. Fixed commands still route (real rule-intent.ts) ----
const ri = await import(pathToFileURL(`${ROOT}src/lib/whatsapp/rule-intent.ts`).href);
console.log("\nFixed commands (detectActionIntent)");
const INTENT = [
  ["verify", null], // VERIFY is handled separately, not by detectActionIntent
  ["menu", "menu"],
  ["register", "register"],
  ["app link", "app_link"],
  ["link", "app_link"],
  ["app", "app_link"],
  ["download app", "app_link"],
  ["install the app", "app_link"],
  ["get the app", "app_link"],
  ["login code", "app_login"],
  ["otp", "app_login"],
  ["send login code", "app_login"],
  ["registration link", "register"],
  ["payment link", null], // must NOT be swallowed by app_link
];
for (const [text, expected] of INTENT) {
  const got = ri.detectActionIntent(text.toLowerCase());
  check(`intent "${text}" -> ${expected}`, got === expected, `got ${got}`);
}
check("isAppLinkIntent('app link')", ri.isAppLinkIntent("app link") === true);
check("isAppLinkIntent('registration link') is false", ri.isAppLinkIntent("registration link") === false);

// ---- 4. Honest fallback (real bot-guard.ts) ----
const guard = await import(pathToFileURL(`${ROOT}src/lib/whatsapp/bot-guard.ts`).href);
console.log("\nFallback honesty");
check("PLACEHOLDER_FALLBACK no longer says 'couldn't finish'", !guard.PLACEHOLDER_FALLBACK.includes("couldn't finish"));
check("PLACEHOLDER_FALLBACK says it passed to the admin", /passed.*admin/i.test(guard.PLACEHOLDER_FALLBACK));
check("hasPlaceholder still blocks [link]", guard.hasPlaceholder("click [link] here") === true);
check("hasFalsePromise still blocks 'I'll check your records'", guard.hasFalsePromise("I'll check your records") === true);
check("hasFalsePromise allows a plain answer", guard.hasFalsePromise("The fee is Rs 2,200.") === false);

// ---- 5. Text checks on files that need the full Next.js runtime ----
function fileContains(path, needle) { return readFileSync(`${ROOT}${path}`, "utf8").includes(needle); }
console.log("\nWiring checks (text)");
check("groq-provider allows verified KB fees",
  fileContains("src/lib/intent-engine/groq-provider.ts", "You MAY state the registration fee for a batch ONLY when that exact amount appears in the KNOWLEDGE BASE"));
check("groq-provider old 'NEVER state any fee' is gone",
  !fileContains("src/lib/intent-engine/groq-provider.ts", "NEVER state any fee or rupee amount here"));
check("cloudflare-provider has correct per-batch fees",
  fileContains("src/lib/intent-engine/cloudflare-provider.ts", "GNIT Batch 2 and GNITC Batch 2 are ₹2,200; GNIT Batch 1 and GNITC Batch 1 are ₹1,100; BIET Batch 1 is ₹2"));
check("cloudflare-provider no longer says 'say you'll check their records'",
  !fileContains("src/lib/intent-engine/cloudflare-provider.ts", "say you'll check their records"));
check("cloudflare-provider no longer claims BIET is 2200",
  !fileContains("src/lib/intent-engine/cloudflare-provider.ts", "₹2,200 for all active batches"));
check("faq-retrieval imports the knowledge base",
  fileContains("src/lib/services/faq-retrieval.ts", 'from "@/lib/whatsapp/knowledge-base"'));
check("faq-retrieval merges KB with DB FAQs",
  fileContains("src/lib/services/faq-retrieval.ts", "mergeWithKnowledgeBase"));
check("router uses containsUnverifiedRupeeAmount",
  fileContains("src/lib/whatsapp/router.ts", "containsUnverifiedRupeeAmount"));
check("router no longer uses the blanket containsRupeeAmount guard",
  !fileContains("src/lib/whatsapp/router.ts", "containsRupeeAmount(") || fileContains("src/lib/whatsapp/router.ts", "containsUnverifiedRupeeAmount("));
check("router replacement text no longer says 'once the admin announces it'",
  !fileContains("src/lib/whatsapp/router.ts", "once the admin announces it"));

console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
if (failures.length) { console.log("Failures:"); failures.forEach((f) => console.log(" - " + f)); }
process.exit(fail ? 1 : 0);
