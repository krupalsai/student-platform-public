// Item #239: a failed request must never bounce a student off the dashboard.
const fs = require("fs");
const hook = fs.readFileSync("src/lib/hooks/useStudentData.ts", "utf8");
const sw = fs.readFileSync("public/sw.js", "utf8");
const dash = fs.readFileSync("src/app/dashboard/page.tsx", "utf8");
const gate = fs.readFileSync("src/components/pwa/StudentAppOnlyGate.tsx", "utf8");
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log("FAIL", n)); };
t("no Promise.all that rejects into router.replace('/')", !/\.catch\(\(\) => router\.replace\("\/"\)\)/.test(hook));
t("requests never throw (abort timeout + null on failure)", /AbortController/.test(hook) && /catch \{ return null; \}/.test(hook));
t("non-JSON reply (gateway timeout page) is tolerated", /catch \{ \/\* non-JSON/.test(hook));
t("only a real 401/403 leaves the screen", /p\.status === 401 \|\| p\.status === 403/.test(hook));
t("transient failure retries, then exposes loadError + reload", /attempt < 5/.test(hook) && /setLoadError\(true\)/.test(hook) && /loadError, reload/.test(hook));
for (const f of ["dashboard", "batch", "payments", "messages", "discussion"])
  t(f + " shows the retry card", /loadError && <LoadFailed/.test(fs.readFileSync(`src/app/${f}/page.tsx`, "utf8")));
t("service worker never answers /api/*", /pathname\.startsWith\("\/api\/"\)\) return;/.test(sw));
t("service worker only answers page navigations (with the offline page, never a saved app: item #248)", /mode === "navigate"/.test(sw) && /offlinePage\(\)/.test(sw) && !/caches\.match\(/.test(sw));
t("service worker version bumped (v6 = no saved app copy)", Number((sw.match(/student-platform-pwa-v(\d+)/) || [])[1]) >= 6);
t("dashboard date rendered after mount (no hydration mismatch)", /setToday\(/.test(dash) && !/\{new Date\(\)\.toLocaleDateString/.test(dash));
t("web-gate cover is client-only", /useState\(false\)/.test(gate) && !/useState\(!open\)/.test(gate));
console.log(`test-dashboard-resilience: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
