// Pins the self-fix rules in /api/cron/self-watch + self-heal.ts.
// Run: node scripts/test-self-heal.cjs
const fs = require("fs");
const path = require("path");
const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const watch = read("src/app/api/cron/self-watch/route.ts");
const heal = read("src/lib/services/self-heal.ts");
let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error("FAIL:", n); } };

check("rollback needs the site down on two consecutive runs", /!site\.ok && siteWasDown/.test(watch));
check("siteWasDown is read before the loop overwrites state", watch.indexOf("const siteWasDown") < watch.indexOf("for (const c of checks)"));
check("rollback needs stored state (no loop on a flapping check)", /if \(state && site && !site\.ok && siteWasDown/.test(watch));
check("rollback at most once a day", /lastRollback[\s\S]{0,80}REALERT_MS/.test(watch));
check("rollback only undoes a deploy from the last 24h", /RECENT_DEPLOY_MS = 24 \* 3_600_000/.test(heal) && /current\.created > RECENT_DEPLOY_MS/.test(heal));
check("rollback targets an earlier READY production deployment", /target=production&state=READY/.test(heal) && /\[current, previous\]/.test(heal));
check("auto-answer threshold is stricter than live search", /AUTO_ANSWER_THRESHOLD = Number\(process\.env\.SELF_HEAL_FAQ_THRESHOLD \?\? 0\.88\)/.test(heal));
check("auto-answer only touches still-pending rows", /\.eq\("status", "pending"\)\s*\.select\("id"\)/.test(heal));
check("auto-answer delivers into the student's thread", /deliverAnswerToAppThreads\(db, \[r\.id\]/.test(heal));
check("stale close spares repeated questions", /\.lt\("occurrence_count", 3\)/.test(heal));
check("stale close marks ignored, never deletes", /status: "ignored"/.test(heal) && !/\.delete\(/.test(heal));
check("self-heal never edits code or settings", !/app_settings|batches/.test(heal));

check("a rate limit is a blip, not an outage", /transient: res\.status === 429 \|\| res\.status >= 500/.test(watch));
check("a blip's first failure does not alert", /if \(!c\.ok && c\.transient\) \{[\s\S]{0,160}saveState\(db, c\.key, status, c\.detail, null\)/.test(watch));
check("a persisting failure alerts on the next run", /!c\.ok && \(!prev\.last_alert_at \|\|/.test(watch));
check("rejected keys still alert immediately", /HTTP \$\{res\.status\}\)\. Students cannot pay right now\.` \};/.test(watch));

console.log(`test-self-heal: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
