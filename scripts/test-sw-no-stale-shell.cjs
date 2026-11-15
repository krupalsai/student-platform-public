// Item #248: a launch with no connection must never be answered with a saved copy of the app.
//
// Up to service worker v5, a page launch that failed on the network was answered with the homepage saved
// at install. That HTML names script files a later deploy deletes, so the page could not load its own
// code ("Loading chunk ... failed" -> "Something went wrong", on every reload while the signal stayed bad).
//
// This runs the real public/sw.js in a sandbox with a fake network and a fake Cache Storage that holds a
// saved copy. Run it against another file to check the test can fail:  node scripts/test-sw-no-stale-shell.cjs <file>
const fs = require("fs");
const vm = require("vm");

const file = process.argv[2] || "public/sw.js";
const code = fs.readFileSync(file, "utf8");
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log("FAIL", n)); };

const SAVED = "SAVED-APP-COPY";

function boot() {
  const listeners = {};
  const state = { skipped: false, claimed: false, opened: 0, matched: 0, deleted: [], cacheNames: ["student-platform-pwa-v5", "student-platform-pwa-v4", "unrelated-cache"] };
  const caches = {
    keys: async () => state.cacheNames.slice(),
    delete: async (k) => { state.deleted.push(k); state.cacheNames = state.cacheNames.filter((x) => x !== k); return true; },
    open: async () => { state.opened++; return { addAll: async () => { state.opened++; }, match: async () => undefined, put: async () => {} }; },
    match: async () => { state.matched++; return new Response(SAVED, { status: 200, headers: { "content-type": "text/html" } }); },
  };
  const self = {
    location: { origin: "https://app.example" },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => { state.skipped = true; },
    clients: { claim: async () => { state.claimed = true; }, matchAll: async () => [], openWindow: async () => {} },
    registration: { showNotification: async () => {} },
  };
  const sandbox = { self, caches, Response, Request, URL, Promise, console, Array, JSON, String, fetch: null };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { listeners, state, sandbox };
}

const down = async () => { throw new TypeError("Failed to fetch"); };
const freshPage = new Response("<html>current app</html>", { status: 200, headers: { "content-type": "text/html" } });
const up = async () => freshPage;

async function fetchEvent(w, { url, method = "GET", mode = "navigate", network }) {
  w.sandbox.fetch = network;
  let answer;
  w.listeners.fetch({ request: { url, method, mode }, respondWith: (p) => { answer = Promise.resolve(p); } });
  return answer ? { handled: true, res: await answer } : { handled: false };
}

(async () => {
  // install: take over at once, save nothing
  {
    const w = boot();
    let pending;
    w.listeners.install({ waitUntil: (p) => { pending = p; } });
    await pending;
    t("install takes over at once", w.state.skipped);
    t("install saves nothing (no cache opened)", w.state.opened === 0);
  }

  // activate: every saved copy goes — including the saved homepage v5 left on student phones
  {
    const w = boot();
    let pending;
    w.listeners.activate({ waitUntil: (p) => { pending = p; } });
    await pending;
    t("activate deletes the v5 saved copy", w.state.deleted.includes("student-platform-pwa-v5"));
    t("activate deletes every other saved copy too", w.state.cacheNames.length === 0 && w.state.deleted.length === 3);
    t("activate claims open pages", w.state.claimed);
  }

  // a launch with no connection
  for (const path of ["/", "/login", "/dashboard", "/admin", "/payments?from=push", "/register?token=abc"]) {
    const w = boot();
    const r = await fetchEvent(w, { url: "https://app.example" + path, network: down });
    const body = r.handled ? await r.res.text() : "";
    t(`no connection ${path}: the worker answers`, r.handled);
    t(`no connection ${path}: answered 200 html`, r.handled && r.res.status === 200 && /text\/html/.test(r.res.headers.get("content-type") || ""));
    t(`no connection ${path}: NOT a saved copy of the app`, !body.includes(SAVED) && w.state.matched === 0 && w.state.opened === 0);
    t(`no connection ${path}: says so and offers Try again`, /No connection/.test(body) && /Try again/.test(body));
    t(`no connection ${path}: needs no app files (cannot hit a removed chunk)`, !/_next\//.test(body) && !/<script[^>]+src=/i.test(body));
    t(`no connection ${path}: reloads itself when the connection returns`, /addEventListener\("online"/.test(body));
  }

  // with a connection the network answer passes through untouched
  {
    const w = boot();
    const r = await fetchEvent(w, { url: "https://app.example/login", network: up });
    t("with a connection the current page is served as is", r.handled && r.res === freshPage);
    t("with a connection nothing saved is touched", w.state.matched === 0 && w.state.opened === 0);
  }

  // things that are never the worker's to answer
  {
    const w = boot();
    t("/api/* is left alone", !(await fetchEvent(w, { url: "https://app.example/api/payments/status", mode: "cors", network: down })).handled);
    t("/api/* navigation is left alone", !(await fetchEvent(w, { url: "https://app.example/api/x", mode: "navigate", network: down })).handled);
    t("a POST is left alone", !(await fetchEvent(w, { url: "https://app.example/login", method: "POST", network: down })).handled);
    t("another origin is left alone", !(await fetchEvent(w, { url: "https://other.example/login", network: down })).handled);
    t("a script file request is left alone", !(await fetchEvent(w, { url: "https://app.example/_next/static/chunks/a.js", mode: "no-cors", network: down })).handled);
    t("an image request is left alone", !(await fetchEvent(w, { url: "https://app.example/pwa-icon.svg", mode: "no-cors", network: down })).handled);
  }

  // what the file itself says
  t("worker never reads or writes Cache Storage for pages", !/caches\.(open|match)\(|\.addAll\(|\.put\(/.test(code));
  t("version marker present and at least v6", Number((code.match(/student-platform-pwa-v(\d+)/) || [])[1]) >= 6);
  {
    const w = boot();
    t("push handler still registered", typeof w.listeners.push === "function");
    t("notification click handler still registered", typeof w.listeners.notificationclick === "function");
  }

  console.log(`test-sw-no-stale-shell (${file}): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("TEST ERROR", e); process.exit(1); });
