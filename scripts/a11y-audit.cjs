// Browser accessibility audit: axe-core (WCAG 2.0/2.1/2.2 A + AA + best practice) driven by Playwright.
// It needs a RUNNING production build, so it is not part of scripts/test-*.cjs. Item #252 explains the context.
//
// One-time setup, outside the repo:   mkdir /tmp/a11y && cd /tmp/a11y && npm i playwright-core axe-core
// Build + serve:  npm run build && npx next start -p 3111   (use placeholder env vars, as .github/workflows/verify.yml does;
//                 never run `next dev` in the same folder - it overwrites .next)
// Run:  A11Y_MODULES=/tmp/a11y/node_modules A11Y_CHROME=/path/to/chrome \
//         node scripts/a11y-audit.cjs http://localhost:3111 <public|app|app2> [outfile.json] [variant] [mobile|desktop]
//   public  every public page          app   the student screens          app2  register / notifications / news / announcements / pay
//   variant (app modes) default | unpaid | rejected | incomplete | chat - the API is mocked, standalone mode is emulated
// Set A11Y_SHOT_DIR=<folder> to also save a full-page screenshot of every page checked (for a visual review).
// Expected result today: "no violations" everywhere. The mock data is an approximation: a screen that crashes on a
// mock shows the global error page, so check the "landed on" note in the output before trusting a clean result.
const path = require("path");
const path_ = path;
const fs = require("fs");
const MODULES = process.env.A11Y_MODULES || path.resolve(__dirname, "../node_modules");
const { chromium } = require(path.join(MODULES, "playwright-core"));
const AXE = fs.readFileSync(path.join(MODULES, "axe-core/axe.min.js"), "utf8");
const [base, mode, outfile, variant, vpOnly] = [process.argv[2], process.argv[3] || "public", process.argv[4], process.argv[5] || "default", process.argv[6]];
if (!base) { console.error("usage: node scripts/a11y-audit.cjs <baseUrl> <public|app|app2> [outfile] [variant] [mobile|desktop]"); process.exit(2); }

const PUBLIC = ["/", "/contact", "/terms", "/privacy-policy", "/refund-policy", "/shipping-policy", "/accessibility",
  "/student-help", "/student-help/epass-scholarship", "/student-help/certificates-documents", "/student-help/registration",
  "/login", "/install", "/college-search"];
const APP = ["/dashboard", "/batch", "/payments", "/messages", "/profile", "/support", "/discussion", "/correction"];
const APP2 = ["/register", "/notifications", "/news", "/news/n1", "/announcements", "/pay/gnitc-batch-1"];
const VIEWPORTS = [{ name: "mobile", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 800 }].filter((v) => !vpOnly || v.name === vpOnly);

const batch = { id: "b1", name: "GNITC Batch 1", slug: "gnitc-batch-1", status: "active", college: "GNITC", fee_amount: "1100.00", case_type: "WP", case_number: "12345", case_year: "2026", representative_name: "Ravi", representative_phone: "9000000001" };
const T = (ms) => new Date(Date.now() + ms).toISOString();
const profile = { id: "p1", full_name: "Ravi Kumar", father_name: "Suresh", college: "GNITC", branch: "CSE", year: 4, phone: "9000000000", role: "student", is_profile_complete: true, batch_id: "b1", batches: batch, roll_number: "20X01A0501", home_address: "Hyderabad" };
function mockData(url) {
  const u = new URL(url).pathname;
  if (u === "/api/auth/session") return { role: "student", is_profile_complete: true, batch_id: "b1" };
  if (u === "/api/profile") return variant === "incomplete" ? { ...profile, is_profile_complete: false, college_id_path: null } : profile;
  if (u === "/api/payments/status") return variant === "unpaid" || variant === "incomplete" ? null : variant === "rejected" ? { status: "rejected", amount: 1100, created_at: T(-3600e3), review_notes: "Amount mismatch" } : { status: "approved", amount: 1100, created_at: T(0) };
  if (u === "/api/announcements") return [{ id: "a1", title: "Court order copy arriving this week", body: "Details inside.", priority: "normal", created_at: new Date().toISOString() }];
  if (u === "/api/settings") return { route_map_enabled: "true", group_chat_enabled: "true", voice_calls_enabled: "false" };
  if (u.includes("case-status")) return { available: true, stale: false, checkedAt: new Date().toISOString(), status: { status: "PENDING", filingDate: "2026-08-20", listingDate: "2026-10-20", judge: "Hon. Justice X", orders: [] } };
  if (u.startsWith("/api/batches/by-slug")) return batch;
  if (u === "/api/case-news" || u.startsWith("/api/case-news/")) return ["filing", "hearing", "order", "next_hearing", "victory", "update"].map((t, i) => ({ id: "n" + i, batch_slug: "gnitc-batch-1", college: "GNITC", batch_name: "GNITC Batch 1", title: "Case update " + (i + 1), body: "The court published an update for your batch.", event_type: t, event_date: T(-86400e3 * (i + 1)), source_url: null }));
  if (u === "/api/notifications") return { __raw: { notifications: [{ id: "x1", type: "payment_reminder", message: "**Reminder:** your batch fee is still due.", channel: "push", created_at: T(-3600e3), read_at: null }, { id: "x2", type: "announcement", message: "New announcement from your batch admin.", channel: "push", created_at: T(-86400e3 * 2), read_at: T(-80000e3) }] } };
  if (u === "/api/batches/seat-progress") return { registered: 52, required: 42, remaining: 0 };
  if (u === "/api/support") return variant === "chat" ? { threads: [{ id: "t1", message: "Payment status", category: "general", priority: "normal", status: "answered", created_at: T(-7200e3), last_message_at: T(-600e3), last_sender: "admin", resolved_at: null, escalated_at: T(-3600e3), admin_responded_at: T(-600e3) }, { id: "t0", message: "Old question", category: "general", priority: "normal", status: "pending_admin", created_at: T(-86400e3), last_message_at: T(-80000e3), last_sender: "bot", resolved_at: null }], messages: [
      { id: "s1", query_id: "t1", sender: "student", body: "Payment status", photo_url: null, created_at: T(-7200e3) },
      { id: "s2", query_id: "t1", sender: "bot", body: "Your payment is approved. Open Payments for the receipt.", photo_url: null, meta: { action: { label: "Open Payments", href: "/payments" } }, created_at: T(-7190e3) },
      { id: "s3", query_id: "t1", sender: "student", body: "When will the order copy come?", photo_url: null, created_at: T(-3700e3) },
      { id: "s4", query_id: "t1", sender: "bot", body: "I have passed this to the support team.", photo_url: null, meta: { escalated: true }, created_at: T(-3690e3) },
      { id: "s5", query_id: "t1", sender: "admin", body: "It is on its way — you will get a notification.", photo_url: null, created_at: T(-600e3) } ] } : { threads: [], messages: [] };
  if (u.startsWith("/api/group-chat")) return variant === "chat" ? [
      { id: "m1", sender_id: "p2", sender_name: "Anil Reddy", sender_role: "student", body: "Has anyone received the order copy?", photo_url: null, created_at: T(-7200e3), seen_count: 3 },
      { id: "m2", sender_id: "p1", sender_name: "Ravi Kumar", sender_role: "student", body: "Not yet, waiting for the notification.", photo_url: null, created_at: T(-7100e3), seen_count: 2 },
      { id: "m3", sender_id: "p3", sender_name: "Admin", sender_role: "system", body: "✅ Priya just paid · 8 of 45 students have now paid", photo_url: null, created_at: T(-3600e3) },
      { id: "m4", sender_id: "p2", sender_name: "Anil Reddy", sender_role: "student", body: "Thanks!", photo_url: null, created_at: T(-60e3) } ] : [];
  return null;
}

(async () => {
  const b = await chromium.launch({ executablePath: process.env.A11Y_CHROME || undefined, args: ["--no-sandbox"] });
  const pages = mode === "app2" ? APP2 : mode === "app" ? APP : PUBLIC;
  const report = [];
  for (const vp of VIEWPORTS) {
    for (const path of pages) {
      const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height } });
      if (mode === "app" || mode === "app2") {
        await ctx.addInitScript(() => {
          localStorage.setItem("sp_token", "x"); localStorage.setItem("sp_role", "student");
          for (const k of ["sp_tour_home", "sp_tour_payments", "sp_tour_messages", "sp_notif_gate_seen", "student-platform-linkedin-feedback-popup-v1"]) localStorage.setItem(k, "1");
          const o = window.matchMedia.bind(window);
          window.matchMedia = (q) => q.includes("standalone") ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : o(q);
        });
      }
      const p = await ctx.newPage();
      if (mode === "app" || mode === "app2") await p.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify((() => { const d = mockData(route.request().url()); return d && d.__raw ? d.__raw : { success: true, data: d }; })()) }));
      let status = 0;
      try { const r = await p.goto(base + path, { waitUntil: "domcontentloaded", timeout: 30000 }); status = r ? r.status() : 0; } catch (e) { report.push({ vp: vp.name, path, error: String(e.message).slice(0, 120) }); await ctx.close(); continue; }
      await p.waitForTimeout(mode !== "public" ? 2500 : 1200);
      const finalPath = new URL(p.url()).pathname;
      await p.addScriptTag({ content: AXE });
      const res = await p.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, tags: v.tags.filter((t) => t.startsWith("wcag") || t === "best-practice").join(","), nodes: v.nodes.slice(0, 300).map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 200), data: n.any && n.any[0] && n.any[0].data ? n.any[0].data : null })), count: v.nodes.length }));
      });
      if (process.env.A11Y_SHOT_DIR) await p.screenshot({ path: path_.join(process.env.A11Y_SHOT_DIR, `${mode}-${variant}-${vp.name}-${(finalPath === "/" ? "home" : finalPath.slice(1)).replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true });
      report.push({ vp: vp.name, path, finalPath, status, violations: res });
      await ctx.close();
    }
  }
  await b.close();
  if (outfile) fs.writeFileSync(outfile, JSON.stringify(report, null, 1));
  // compact summary
  const agg = {};
  for (const r of report) {
    if (r.error) { console.log(`ERR  ${r.vp} ${r.path}: ${r.error}`); continue; }
    const tag = r.finalPath !== r.path ? ` (landed on ${r.finalPath})` : "";
    console.log(`${r.vp.padEnd(8)} ${r.path}${tag}: ${r.violations.length ? r.violations.map((v) => `${v.id}[${v.impact}]x${v.count}`).join(", ") : "no violations"}`);
    for (const v of r.violations) { const k = v.id; (agg[k] = agg[k] || { impact: v.impact, help: v.help, tags: v.tags, pages: new Set(), count: 0 }); agg[k].pages.add(r.path); agg[k].count += v.count; }
  }
  console.log("\n=== by rule");
  for (const [k, v] of Object.entries(agg).sort((a, b) => b[1].count - a[1].count)) console.log(`${k} [${v.impact}] ${v.tags} — ${v.help} — ${v.count} nodes on ${[...v.pages].join(" ")}`);
})();
