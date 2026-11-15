// Admin "Case News" (a hand-typed form that never held a row) was replaced by "Court News":
// what happened in each batch's court case, read from the High Court's own record.
// Pins: (1) the record is turned into plain-English events, newest first, with the court's two
// date shapes handled; (2) it never claims a win, never carries names or case numbers;
// (3) the loader/feed work against a fake database (court down, stale copy, no case, archived,
// merchant-demo batch); (4) the menu, drawer and student pages are wired to it.
// Run: node scripts/test-court-timeline.cjs
const fs = require("fs");
const path = require("path");
const jiti = require("jiti")(__filename, { alias: { "@": path.resolve(__dirname, "../src") }, interopDefault: true });
const clarity = jiti("../src/lib/case-clarity.ts");
const tl = jiti("../src/lib/court-timeline.ts");
const cc = jiti("../src/lib/services/court-case.ts");
const news = jiti("../src/lib/services/court-news.ts");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) pass++; else { fail++; console.error("FAIL:", name); } };

const NOW = Date.parse("2026-10-18T06:00:00Z"); // 18 Oct 2026, 11:30 in India

// ---- 1. dates: the court uses ISO for orders and dd-mm-yyyy / dd/mm/yyyy elsewhere ---------------
t("ISO date", clarity.courtDateToISO("2026-10-13") === "2026-10-13");
t("dd-mm-yyyy", clarity.courtDateToISO("13-10-2026") === "2026-10-13");
t("dd/mm/yyyy", clarity.courtDateToISO("13/10/2026") === "2026-10-13");
t("single-digit day and month", clarity.courtDateToISO("3/9/2026") === "2026-09-03");
t("ISO with time", clarity.courtDateToISO("2026-10-13T00:00:00") === "2026-10-13");
t("garbage and empty give null", clarity.courtDateToISO("soon") === null && clarity.courtDateToISO("") === null && clarity.courtDateToISO(null) === null);
t("an impossible month gives null", clarity.courtDateToISO("13-14-2026") === null);
t("today in India, late evening UTC is already tomorrow there", tl.todayISTDate(Date.parse("2026-10-24T20:00:00Z")) === "2026-10-25");
t("today in India, morning", tl.todayISTDate(NOW) === "2026-10-18");

// ---- 2. the timeline ------------------------------------------------------------------------------
// Made-up record shaped like the real ones: ISO order dates, dd/mm/yyyy filing dates, dd-mm-yyyy disposal.
const base = {
  status: "PENDING", listingDate: null, filingDate: "13/08/2026", registrationDate: "17/08/2026",
  disposalDate: null, disposalType: null, judges: null, purpose: null, latestOrder: null,
  orders: [], applications: [], filings: [], petitionerCount: 30,
};
const order = (date, type, url, judge) => ({ date, type, url, judge: judge ?? "The Honourable Sri Justice A B SAMPLE" });
const closedA = {
  ...base, status: "DISPOSED", listingDate: "28/09/2026", disposalDate: "28-09-2026", disposalType: "ALLOWED NO COSTS",
  purpose: "ADMISSION (EDUCATION )",
  orders: [order("2026-09-02", "DAILY ORDER", "https://court.example/o2.pdf"), order("2026-08-19", "Spl Cell Orders", "https://court.example/o1.pdf")],
  applications: [{ date: "2026-08-17", type: "Direction Petition", status: "Pending", decidedOn: null }],
  filings: [
    { date: "2026-09-02", type: "Counter Affidavit", status: "Accepted" },
    { date: "2026-08-31", type: "Memo Proof of Service", status: "Accepted" },
    { date: "2026-08-31", type: "VAKALATH", status: "ACCEPTED  R5" },
    { date: "2026-08-19", type: "VAKALATH", status: "ACCEPTED  R4" },
  ],
};
const evA = tl.buildCourtTimeline(closedA, NOW);
t("A: ten events", evA.length === 10);
t("A: newest first", evA.every((e, i) => i === 0 || evA[i - 1].date >= e.date));
t("A: the case closing is on top", evA[0].type === "disposed" && evA[0].date === "2026-09-28" && evA[0].title === "Case closed (disposed)");
t("A: same day, the order comes before the paper filed that day", evA[1].type === "order" && evA[2].title === "Counter affidavit filed");
t("A: petition filed is last", evA[evA.length - 1].title === "Petition filed" && evA[evA.length - 1].date === "2026-08-13");
t("A: on registration day the application filed shows above 'registered'", evA.findIndex((e) => e.title.startsWith("Application filed")) < evA.findIndex((e) => e.title === "Case registered"));
t("A: ids are unique", new Set(evA.map((e) => e.id)).size === evA.length);
t("A: ids are stable", JSON.stringify(tl.buildCourtTimeline(closedA, NOW).map((e) => e.id)) === JSON.stringify(evA.map((e) => e.id)));
t("A: orders carry their own PDF", evA.filter((e) => e.type === "order").every((e) => /^https:\/\/court\.example\/o\d\.pdf$/.test(e.url)));
t("A: order wording is plain", evA.some((e) => e.title === "Court order: Daily order") && evA.some((e) => e.title === "Court order: Special Cell order"));
t("A: judge shown without the honorific and not in shouty case", evA.some((e) => /Passed by Sri Justice A B Sample\./.test(e.body)));
t("A: papers are explained in plain words", evA.some((e) => e.title === "Vakalat filed" && /lawyer's written authority/.test(e.body) && /Accepted into the case file/.test(e.body)));
t("A: counter affidavit explained", evA.some((e) => e.title === "Counter affidavit filed" && /written reply to the petition/.test(e.body)));
t("A: proof of service explained", evA.some((e) => e.title === "Proof of service memo filed" && /notice was delivered/.test(e.body)));
t("A: a closed case doesn't call its leftover application 'pending'", evA.some((e) => e.title === "Application filed: Direction Petition" && e.body === "A request made inside the case."));
t("a pending case says its application is still pending", tl.buildCourtTimeline({ ...base, applications: [{ date: "2026-08-17", type: "Direction Petition", status: "Pending", decidedOn: null }] }, NOW).some((e) => e.title === "Application filed: Direction Petition" && /It is still pending\./.test(e.body)));
t("A: routine paperwork is minor; milestones are not", evA.filter((e) => e.minor).length === 5 && evA.filter((e) => !e.minor).length === 5);
t("A: filed, registered, orders and closing are milestones", ["Petition filed", "Case registered", "Case closed (disposed)"].every((ti) => evA.find((e) => e.title === ti && !e.minor)) && evA.filter((e) => e.type === "order").every((e) => !e.minor));
t("A: no hearing event once the case is closed", !evA.some((e) => e.type === "next_hearing" || e.type === "hearing"));
t("A: closed body says the court's label", /The court's label: "ALLOWED NO COSTS"/.test(evA[0].body));
t("A: no order for the closing day yet -> says the written order isn't out", /written order is not published yet/.test(evA[0].body));

const closedB = {
  ...base, status: "DISPOSED", listingDate: "13/10/2026", filingDate: "28/09/2026", registrationDate: "28/09/2026",
  disposalDate: "13-10-2026", disposalType: "DISPOSED OF NO COSTS",
  orders: [order("2026-10-12", "DAILY ORDER", "https://court.example/b3.pdf"), order("2026-10-09", "DAILY ORDER", "https://court.example/b2.pdf")],
};
const evB = tl.buildCourtTimeline(closedB, NOW);
t("B: closing event first", evB[0].type === "disposed" && evB[0].date === "2026-10-13");
t("B: 'no costs' is not described as a win", !/favou?r|allowed|victory/i.test(evB[0].body.replace(/who won/g, "")));
t("B: says it doesn't tell who won", /doesn't tell us who won/.test(evB[0].body));
t("B: written order not out", /not published yet/.test(evB[0].body) && /can't yet confirm/.test(evB[0].body));
const evBpub = tl.buildCourtTimeline({ ...closedB, orders: [order("2026-10-13", "DAILY ORDER", "https://court.example/b4.pdf"), ...closedB.orders] }, NOW);
t("B published: the closing event says it is out (ISO order vs dd-mm-yyyy disposal)", /written order for that day is published/.test(evBpub[0].body));
t("B published: both the closing and the order are listed for the day, closing first", evBpub[0].type === "disposed" && evBpub[1].type === "order" && evBpub[1].date === "2026-10-13");
const evBnoPdf = tl.buildCourtTimeline({ ...closedB, orders: [order("2026-10-13", "DAILY ORDER", null)] }, NOW);
t("B listed without a PDF: says the PDF isn't out", /PDF is not out yet/.test(evBnoPdf[0].body) && evBnoPdf.find((e) => e.type === "order").body.includes("PDF is not on the court's website yet"));

const decided = tl.buildCourtTimeline({ ...base, applications: [{ date: "2026-09-28", type: "Direction Petition", status: "Disposed", decidedOn: "2026-10-13" }] }, NOW);
t("a disposed application also shows when it was decided", decided.some((e) => e.title === "Application decided: Direction Petition" && e.date === "2026-10-13" && e.minor) && decided.some((e) => e.title === "Application filed: Direction Petition" && /since disposed/.test(e.body)));

// pending case: hearings
const pend = { ...base, listingDate: "25/10/2026", purpose: "ADMISSION (EDUCATION )", orders: [order("2026-10-09", "DAILY ORDER", "https://court.example/p1.pdf")] };
const evP = tl.buildCourtTimeline(pend, NOW);
t("pending, hearing ahead: next hearing is on top", evP[0].type === "next_hearing" && evP[0].title === "Next hearing" && evP[0].date === "2026-10-25");
t("pending, hearing ahead: says the date and what it is for", /25 Oct 2026/.test(evP[0].body) && /Listed for: Admission \(Education\)\./.test(evP[0].body));
const evToday = tl.buildCourtTimeline(pend, Date.parse("2026-10-24T20:00:00Z"));
t("a hearing today is flagged (India date, not UTC)", evToday[0].type === "hearing" && evToday[0].title === "Hearing today" && /listed today/.test(evToday[0].body));
const evPast = tl.buildCourtTimeline(pend, Date.parse("2026-10-26T06:00:00Z"));
t("a past listing date on a pending case is not news", !evPast.some((e) => e.type === "next_hearing" || e.type === "hearing"));
t("a closed case ignores a future-looking listing date", !tl.buildCourtTimeline({ ...closedB, listingDate: "30/12/2026" }, NOW).some((e) => e.type === "next_hearing"));

// robustness
t("empty record gives no events and no crash", tl.buildCourtTimeline({ ...base, filingDate: null, registrationDate: null }, NOW).length === 0);
t("undated rows are dropped, not guessed", tl.buildCourtTimeline({ ...base, filingDate: "n/a", filings: [{ date: null, type: "VAKALATH", status: "Accepted" }], orders: [order("garbage", "DAILY ORDER", null)] }, NOW).filter((e) => e.type === "order" || e.title === "Vakalat filed" || e.title === "Petition filed").length === 0);
t("missing arrays are fine (a cache row from before this feature)", tl.buildCourtTimeline({ ...closedB, applications: undefined, filings: undefined }, NOW).length >= 3);
t("unknown order and paper types are title-cased, not dropped", (() => { const e = tl.buildCourtTimeline({ ...base, filings: [{ date: "2026-09-01", type: "ADDITIONAL AFFIDAVIT", status: null }], orders: [order("2026-09-02", "INTERIM ORDER", null)] }, NOW); return e.some((x) => x.title === "Additional Affidavit filed") && e.some((x) => x.title === "Court order: Interim Order"); })());
t("a registry 'pending for scrutiny' note is put plainly", tl.buildCourtTimeline({ ...base, filings: [{ date: "2026-09-01", type: "MEMO", status: "PENDING FOR SCRUTINY" }] }, NOW).some((e) => e.title === "Memo filed" && /Waiting for the court registry/.test(e.body)));

// the rules
const all = [...evA, ...evB, ...evBpub, ...evP, ...decided];
t("never a 'victory' event", all.every((e) => e.type !== "victory") && !/victory/.test(read("src/lib/court-timeline.ts").match(/export type CourtEventType =[^;]+;/)[0]));
t("no case numbers in any event", all.every((e) => !/\b[A-Z]{2,5}\s*\d{3,6}\s*\/\s*20\d\d\b/.test(e.title + " " + e.body)));
t("no petitioner or advocate names reach an event", (() => {
  const rec = { ...closedA, petitioners: [{ petName: "Someone Private" }], mainPetitioner: "Someone Private", advName: "Some Advocate" };
  return tl.buildCourtTimeline(rec, NOW).every((e) => !/Someone Private|Some Advocate/.test(e.title + e.body));
})());

// headline + latest-happened
const hA = tl.courtHeadline(closedA, NOW), hB = tl.courtHeadline(closedB, NOW), hP = tl.courtHeadline(pend, NOW);
t("headline: closed", hA.tone === "closed" && hA.headline === "Case closed on 28 Sep 2026" && /not published yet/.test(hA.detail));
t("headline: closed, order published", /is published/.test(tl.courtHeadline({ ...closedB, orders: [order("2026-10-13", "DAILY ORDER", "https://court.example/b4.pdf")] }, NOW).detail));
t("headline: closed B", hB.headline === "Case closed on 13 Oct 2026");
t("headline: next hearing", hP.tone === "pending" && hP.headline === "Next hearing on 25 Oct 2026" && hP.detail === "Listed for: Admission (Education)");
t("headline: nothing scheduled", tl.courtHeadline({ ...base, listingDate: "01/10/2026" }, NOW).headline === "Case is pending");
t("latest happened skips a hearing still to come", tl.latestHappenedDate(evP, NOW) === "2026-10-09");
t("latest happened for a closed case", tl.latestHappenedDate(evA, NOW) === "2026-09-28");
t("latest happened with nothing", tl.latestHappenedDate([], NOW) === null);

// student feed shape
const items = tl.toNewsItems({ slug: "demo-batch-1", name: "Demo Batch 1", college: "DEMO" }, evA);
t("feed: milestones only", items.length === 5 && items.every((i) => !/ filed$/.test(i.title) || i.title === "Petition filed"));
t("feed: ids start with the batch slug and are url-safe", items.every((i) => i.id.startsWith("demo-batch-1.") && /^[a-z0-9.\-]+$/.test(i.id)));
t("feed: carries the batch, ISO date and the order's PDF", items.every((i) => i.batch_slug === "demo-batch-1" && i.college === "DEMO" && /^\d{4}-\d\d-\d\d$/.test(i.event_date)) && items.some((i) => i.event_type === "order" && /^https:\/\/court\.example\//.test(i.source_url)));

// ---- 3. compact rows kept from the court's record ---------------------------------------------------
const apps = cc.parseApplications([
  { iaNumber: "IA 1/2026", filingDate: "2026-08-17", miscPaperType: "Direction Petition", status: "Pending", orderDate: null, prayer: "A long private prayer text", advName: "Some Advocate" },
  { filingDate: "2026-09-28", miscPaperType: "X".repeat(300), status: "Disposed", orderDate: "2026-10-13" },
  null, "junk", 5,
]);
t("applications: newest first, only the four fields", apps.length === 2 && apps[0].date === "2026-09-28" && JSON.stringify(Object.keys(apps[0])) === JSON.stringify(["date", "type", "status", "decidedOn"]));
t("applications: no IA number, prayer or advocate kept", !JSON.stringify(apps).includes("IA 1/2026") && !JSON.stringify(apps).includes("prayer") && !JSON.stringify(apps).includes("Some Advocate"));
t("applications: long text is clipped", apps[0].type.length === 80);
const fil = cc.parseFilings([{ usrNumber: "9/2026", usrType: "VAKALATH", usrDate: "2026-08-19", remarks: "ACCEPTED  R4" }, { usrType: "Counter Affidavit", usrDate: "2026-09-02", remarks: "Accepted" }]);
t("filings: newest first, only date/type/status", fil[0].type === "Counter Affidavit" && JSON.stringify(Object.keys(fil[0])) === JSON.stringify(["date", "type", "status"]) && !JSON.stringify(fil).includes("9/2026"));
t("filings: spaces squashed", fil[1].status === "ACCEPTED R4");
t("parsers survive non-arrays", cc.parseApplications(undefined).length === 0 && cc.parseFilings({}).length === 0 && cc.parseFilings("x").length === 0);
t("parsers cap the rows", cc.parseFilings(Array.from({ length: 300 }, (_, i) => ({ usrType: "MEMO", usrDate: "2026-09-01", remarks: String(i) }))).length === 40);

// ---- 4. the loader and the student feed, against a fake database ----------------------------------------
function fakeDb({ batches, colleges }) {
  const from = (table) => {
    const st = { filters: [], op: "select", payload: null };
    const rowsFor = () => {
      let rows = table === "batches" ? batches : table === "colleges" ? colleges : [];
      for (const [op, c, v] of st.filters) rows = rows.filter((r) => (op === "eq" ? r[c] === v : String(r[c]) !== String(v)));
      return rows;
    };
    const run = (single) => {
      const rows = rowsFor();
      if (st.op === "update") { rows.forEach((r) => Object.assign(r, st.payload)); return null; }
      return single ? rows[0] ?? null : rows;
    };
    const q = {
      select() { return q; }, order() { return q; },
      neq(c, v) { st.filters.push(["neq", c, v]); return q; },
      eq(c, v) { st.filters.push(["eq", c, v]); return q; },
      update(p) { st.op = "update"; st.payload = p; return q; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      maybeSingle() { return Promise.resolve({ data: run(true), error: null }); },
      then(res, rej) { return Promise.resolve({ data: run(false), error: null }).then(res, rej); },
    };
    return q;
  };
  return { from };
}
const fresh = new Date(Date.now() - 60_000).toISOString();
const cacheOf = (rec) => ({ mainPetitioner: "n/a", ...rec });
const mk = (id, name, college, status, caseNo, cache, checked) => ({
  id, slug: name.toLowerCase().replace(/ /g, "-"), name, college, status,
  case_type: caseNo ? "WP" : null, case_number: caseNo, case_year: caseNo ? "2026" : null,
  case_last_status_json: cache ?? null, case_status_checked_at: checked ?? null,
});
const realFetch = global.fetch;
global.fetch = async () => { throw new Error("court offline"); }; // no test may reach the real court
(async () => {
  const batches = [
    mk("b1", "Demo A Batch 1", "DEMOA", "closed", "10001", cacheOf(closedA), fresh),
    mk("b2", "Demo B Batch 1", "DEMOB", "closed", "10002", cacheOf(closedB), fresh),
    mk("b3", "Demo A Batch 2", "DEMOA", "active", null, null, null),
    mk("b4", "Payment Demo", "PGDEMO", "active", null, null, null),
    mk("b5", "Old Archived", "DEMOA", "archived", "10003", cacheOf(closedA), fresh),
    mk("b6", "Demo B Batch 2", "DEMOB", "active", "10004", null, null),
    mk("b7", "Demo A Stale Copy", "DEMOA", "closed", "10005", cacheOf(pend), new Date(Date.now() - 5 * 3600e3).toISOString()),
  ];
  const colleges = ["DEMOA", "DEMOB"].map((id) => ({ id, name: id, active: true, institution_type: "engineering", search_aliases: [] }));
  const db = fakeDb({ batches, colleges });

  const list = await news.loadCourtNews(db, { includeWithoutCase: true, nowMs: NOW });
  const names = list.map((b) => b.name);
  t("loader: archived and merchant-demo batches are left out", !names.includes("Old Archived") && !names.includes("Payment Demo"));
  t("loader: a running batch with no case is listed (so 'add the case number' can be offered)", names.includes("Demo A Batch 2"));
  t("loader: batches with news first, no-case last", names[names.length - 1] === "Demo A Batch 2" && names.indexOf("Demo B Batch 1") < names.indexOf("Demo A Batch 1"));
  const b1 = list.find((b) => b.id === "b1"), b6 = list.find((b) => b.id === "b6"), b7 = list.find((b) => b.id === "b7"), b3 = list.find((b) => b.id === "b3");
  t("loader: a batch's card has the label, headline and events", b1.caseLabel === "WP 10001 / 2026" && b1.court.headline === "Case closed on 28 Sep 2026" && b1.events.length === 10 && b1.lastHappened === "2026-09-28");
  t("loader: fresh copy is served without calling the court", b1.court.stale === false && b1.court.checkedAt === fresh);
  t("loader: court down and nothing saved -> no court block, no crash", b6.court === null && b6.events.length === 0 && b6.caseLabel === "WP 10004 / 2026");
  t("loader: court down but an older copy exists -> shown, marked as the last copy", b7.court !== null && b7.court.stale === true && b7.events.length > 0);
  t("loader: no case -> no label, no events", b3.caseLabel === null && b3.court === null && b3.events.length === 0);
  const feedLoader = await news.loadCourtNews(db, { nowMs: NOW });
  t("feed loader: leaves out batches without a case", !feedLoader.some((b) => b.caseLabel === null));

  const feed = await news.loadCourtNewsFeed(db);
  t("student feed: milestones from every batch, newest first", feed.length > 0 && feed.every((i, k) => k === 0 || feed[k - 1].event_date >= i.event_date) && new Set(feed.map((i) => i.batch_slug)).size >= 2);
  t("student feed: no routine paperwork", feed.every((i) => !/ filed$/.test(i.title) || i.title === "Petition filed"));
  t("student feed: carries only facts (no case number, no names)", feed.every((i) => !/WP\s*1000\d/.test(i.title + i.body) && !/Someone|Advocate/.test(i.title + i.body)));
  t("student feed: ids are unique", new Set(feed.map((i) => i.id)).size === feed.length);
  const one = await news.loadCourtNewsFeed(db, { batch: "demo-a-batch-1" });
  t("student feed: can be limited to one batch", one.length > 0 && one.every((i) => i.batch_slug === "demo-a-batch-1"));
  const byCollege = await news.loadCourtNewsFeed(db, { college: "DEMOB" });
  t("student feed: can be limited to one college", byCollege.length > 0 && byCollege.every((i) => i.college === "DEMOB"));
  t("student feed: capped", (await news.loadCourtNewsFeed(db, {}, 3)).length === 3);
  global.fetch = realFetch;

  // ---- 5. wiring --------------------------------------------------------------------------------------
  const caseNewsApi = read("src/app/api/case-news/route.ts");
  t("student API: GET only, from the court record, no manual table", /export async function GET/.test(caseNewsApi) && !/export async function (POST|DELETE|PUT|PATCH)/.test(caseNewsApi) && !/case_news/.test(caseNewsApi.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) && /loadCourtNewsFeed/.test(caseNewsApi) && /requireSession/.test(caseNewsApi) && !/requireAdmin/.test(caseNewsApi));
  const adminApi = read("src/app/api/admin/court-news/route.ts");
  t("admin API: admin-only, GET only, includes batches without a case", /requireAdmin/.test(adminApi) && /export async function GET/.test(adminApi) && !/export async function (POST|DELETE|PUT|PATCH)/.test(adminApi) && /includeWithoutCase:\s*true/.test(adminApi));
  const oldPage = read("src/app/admin/case-news/page.tsx");
  t("old Case News page only redirects", /redirect\(["']\/admin\/court-news["']\)/.test(oldPage) && !/fetch\(/.test(oldPage) && !/useState/.test(oldPage));
  const page = read("src/app/admin/court-news/page.tsx");
  t("Court News page reads the admin API and has no editor", /\/api\/admin\/court-news/.test(page) && !/method:\s*["']POST|DELETE/.test(page) && !/<textarea|<input/.test(page));
  t("Court News page: closed is neutral, not a win colour", /disposed:\s*\{[^}]*"Case closed"[^}]*ui\.textPrimary/.test(page));
  t("Court News page: PDF links open safely", /rel="noopener noreferrer"/.test(page));
  t("Court News page: offers adding a case number for a batch without one", /Add case number/.test(page) && /\/admin\/batches/.test(page));

  const menu = read("src/app/admin/page.tsx");
  const items = [...menu.matchAll(/\{group:"([^"]+)",Icon:\w+,label:"([^"]+)",sub:"([^"]+)",path:"([^"]+)"/g)].map((m) => ({ group: m[1], label: m[2], sub: m[3], path: m[4] }));
  t("menu: all 15 tools are described", items.length === 15);
  t("menu: Court News replaced Case News", items.some((i) => i.label === "Court News" && i.path === "/admin/court-news") && !/Case News|\/admin\/case-news|Newspaper/.test(menu));
  t("menu: every tool says in plain words what it is for", items.every((i) => i.sub.length >= 20 && i.sub.length <= 70));
  t("menu: no jargon in the descriptions", items.every((i) => !/\b(UTR|DOCX|VPA|JSON|API|SFU|RLS)\b/.test(i.sub)));
  t("menu: grouped, and each group is one run (no heading repeated)", (() => { const seq = []; items.forEach((i) => { if (seq[seq.length - 1] !== i.group) seq.push(i.group); }); return new Set(seq).size === seq.length && seq.length >= 4; })());
  t("menu: Manual UPI is gone (flow deleted)", !/Manual UPI|\/admin\/upi-payments|onlyWhenPending|PendingBanner/.test(menu));
  t("menu and search both use canShow", (menu.match(/canShow\(/g) || []).length >= 3);
  t("menu: no pending banner links anywhere", !/PendingBanner/.test(menu));
  t("menu: Super Admin only items stay hidden from plain admins", /label:"Settings"[^}]*superAdminOnly:true/.test(menu) && /label:"Route Map"[^}]*superAdminOnly:true/.test(menu) && /label:"Court News"[^}]*adminOnly:true/.test(menu) && !/label:"Court News"[^}]*superAdminOnly/.test(menu));
  t("menu: search box says it finds tools", /Find a tool/.test(menu) && !/Search students, payments, batches/.test(menu));
  t("Home: no role is claimed ('Viewer') before the real role is known", /\{mounted\?\(isSuperAdmin\?"Super Admin ":isAdmin\?"Admin ":"Viewer "\):""\}Console/.test(menu));
  t("menu: the close button has a name and the panel is a navigation landmark", /aria-label="Close menu"/.test(menu) && /role="navigation" aria-label="Admin menu"/.test(menu));
  t("Home: the role label no longer differs between the server render and the first browser render (hydration error 418)", /const\[mounted,setMounted\]=useState\(false\)/.test(menu) && /sessionRole=liveRole\?\?\(mounted\?localStorage\.getItem\("sp_role"\):null\)/.test(menu) && !/typeof window!=="undefined"\?localStorage\.getItem\("sp_role"\)/.test(menu));

  const drawer = read("src/components/admin/AdminNavDrawer.tsx");
  t("drawer: Court News in, Manual UPI out, no Case News", /\/admin\/court-news/.test(drawer) && !/upi-payments/.test(drawer) && !/case-news/.test(drawer));
  t("drawer: the close button has a name and the panel is a navigation landmark", /aria-label="Close navigation"/.test(drawer) && /role="navigation" aria-label="Admin navigation"/.test(drawer));
  const hasIdx = (s, re) => re.test(s);
  t("the Home slide-out menu overlay uses zIndex 40 and the panel 50", hasIdx(menu, /zIndex:40,background:"rgba\(0,0,0,\.42\)"/) && hasIdx(menu, /zIndex:50,width:"82vw"/));

  for (const f of ["src/app/news/page.tsx", "src/app/news/[id]/page.tsx"]) {
    const src = read(f);
    t(`${f}: knows the 'closed' type and survives an unknown one`, /disposed:\s*\{ label: "Case closed"/.test(src) && /TYPE_META\[[^\]]+\] \?\? TYPE_META\.update/.test(src));
  }
  const dash = read("src/app/dashboard/page.tsx");
  t("Home tile prefers the student's own batch news", /newsList\.find\(n => n\.batch_slug === batch\?\.slug\) \?\? newsList\[0\]/.test(dash));

  const court = read("src/lib/services/court-case.ts");
  t("old cached copies are refreshed once for the new fields", /"applications" in cached && "filings" in cached/.test(court));
  t("the fetch stores the compact applications and filings", /applications: parseApplications\(data\.ia\)/.test(court) && /filings: parseFilings\(data\.usr\)/.test(court));

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
