// Item #237: the web is for admins + public pages only; everyone else uses the app.
const fs = require("fs");
const g = fs.readFileSync("src/components/pwa/StudentAppOnlyGate.tsx", "utf8");
const layout = fs.readFileSync("src/app/layout.tsx", "utf8");
const status = fs.readFileSync("src/app/api/payments/status/route.ts", "utf8");
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log("FAIL", n)); };
t("gate is mounted in the root layout", /<StudentAppOnlyGate \/>/.test(layout));
t("gate is not a no-op", /window\.location\.replace\(/.test(g) && /\/install/.test(g));
t("hard navigation, not router.replace (page guards race it)", !/router\.replace\(.*install/.test(g));
for (const p of ["/admin", "/install", "/login", "/terms", "/privacy-policy", "/refund-policy", "/shipping-policy", "/contact", "/accessibility", "/student-help", "/merchant-demo", "/college-search"])
  t("public/admin path stays open: " + p, g.includes(`"${p}"`));
t("installed app, native shell, Telegram, preview and staff are exempt", /display-mode: standalone/.test(g) && /isNativePlatform/.test(g) && /initData/.test(g) && /preview_token/.test(g) && /super_admin/.test(g));
t("registration token survives the redirect", /install\?token=/.test(g));
t("payments/status caps old orders and runs in parallel", /limit\(3\)/.test(status) && /Promise\.all\(/.test(status) && !/for \(const candidate of candidates/.test(status));
t("global error screen reloads once, no loop", fs.existsSync("src/app/global-error.tsx") && /sp_error_reloaded/.test(fs.readFileSync("src/app/global-error.tsx", "utf8")));
console.log(`test-web-gate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
