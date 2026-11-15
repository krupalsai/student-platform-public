// Notification sounds (item #257).
//
// Two causes of "the app has no notification sounds", both covered here:
//  1. public/sw.js showed every push with renotify off. Every notification has a tag, a newer one of the
//     same tag replaces the old one, and a replacement is SILENT unless renotify is on - so the second
//     login code (or update) while the first still sat in the tray made no sound at all.
//  2. Nothing played a sound for a message or reply that arrives while the app is open on screen.
//
// A third rule keeps the two from sounding twice: when the student is already ON the screen that shows a push
// live (Batch Discussion for a chat message, Support for a team reply), the worker shows the system alert quietly
// and tells the screen to refresh - the screen's own pop is the only sound.
//
// Part 1 runs the real public/sw.js in a sandbox. Part 2 runs the real src/lib/notification-sound.ts against
// a fake browser (fake AudioContext, storage, page visibility, clock). Part 3 pins how the screens use it.
// Run:  node scripts/test-notification-sound.cjs [path/to/sw.js]   (give another sw.js to check the test can fail)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const swFile = process.argv[2] || path.join(root, "public/sw.js");
const swCode = fs.readFileSync(swFile, "utf8");
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : (fail++, console.log("FAIL", name)); };
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// ---------------------------------------------------------------- part 1: the service worker
const win = (path, o = {}) => ({ url: "https://app.example" + path, visibilityState: "visible", focused: true, ...o });

function bootSw({ windows, matchAllFails = false } = {}) {
  const listeners = {};
  const shown = [];
  const posted = [];
  const open = (windows || [win("/login")]).map((w, i) => ({ ...w, id: i, postMessage: (m) => posted.push({ to: i, ...m }) }));
  const self = {
    location: { origin: "https://app.example" },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {}, openWindow: async () => {},
      matchAll: async () => { if (matchAllFails) throw new Error("matchAll failed"); return open; },
    },
    // The real browser throws a TypeError when renotify is true and the tag is empty.
    registration: {
      showNotification: async (title, opts) => {
        if (opts && opts.renotify && !opts.tag) throw new TypeError("renotify requires a tag");
        if (opts && opts.silent === true && opts.vibrate) throw new TypeError("silent and vibrate together");
        shown.push({ title, opts });
      },
    },
  };
  const sandbox = { self, caches: { keys: async () => [], delete: async () => true }, Response, Request, URL, Promise, console, Array, JSON, String, fetch: null };
  vm.createContext(sandbox);
  vm.runInContext(swCode, sandbox);
  return { listeners, shown, posted };
}

async function push(w, payload, { text } = {}) {
  let pending;
  const data = payload === undefined
    ? undefined
    : { json: () => { if (text !== undefined) throw new SyntaxError("not json"); return payload; }, text: () => text ?? JSON.stringify(payload) };
  w.listeners.push({ data, waitUntil: (p) => { pending = p; } });
  if (pending) await pending;
}

async function swTests() {
  // an ordinary update
  {
    const w = bootSw();
    await push(w, { title: "Payment update", body: "Approved", tag: "student-platform-payment-update", url: "/payments" });
    const o = w.shown[0] && w.shown[0].opts;
    t("an ordinary push is shown", w.shown.length === 1 && w.shown[0].title === "Payment update");
    t("a replacement of the same tag alerts again (renotify)", o && o.renotify === true);
    t("the notification is explicitly not silent", o && o.silent === false);
    t("it vibrates by default", o && Array.isArray(o.vibrate) && o.vibrate.length >= 1);
    t("its own tag is kept", o && o.tag === "student-platform-payment-update");
    t("it does not stay on screen demanding a tap", o && o.requireInteraction === false);
    t("tapping it still goes to the page asked for", o && o.data && o.data.url === "/payments");
  }

  // the login code: the case that made the second code of a day silent
  {
    const w = bootSw();
    await push(w, { title: "Your login code", body: "123456", tag: "login-otp", otp: "123456" });
    const o = w.shown[0] && w.shown[0].opts;
    t("login code: shown with renotify, so a second code still makes a sound", o && o.tag === "login-otp" && o.renotify === true && o.silent === false);
    t("login code: still handed to an open login screen", w.posted.some((m) => m.type === "sp_login_otp" && m.otp === "123456"));
  }
  {
    const w = bootSw();
    await push(w, { title: "Confirm it's you", body: "654321", tag: "registration-otp", otp: "654321" });
    t("registration code: renotify too", w.shown[0] && w.shown[0].opts.renotify === true && w.shown[0].opts.tag === "registration-otp");
  }

  // no tag / a tag that is not a string: renotify needs a non-empty tag or the browser throws
  for (const [label, payload] of [
    ["no tag", { title: "Hi", body: "x" }],
    ["empty tag", { title: "Hi", body: "x", tag: "" }],
    ["numeric tag", { title: "Hi", body: "x", tag: 5 }],
    ["null tag", { title: "Hi", body: "x", tag: null }],
  ]) {
    const w = bootSw();
    await push(w, payload);
    const o = w.shown[0] && w.shown[0].opts;
    t(`${label}: still shown (the browser would reject renotify without a tag)`, w.shown.length === 1);
    t(`${label}: falls back to the default tag and still renotifies`, o && o.tag === "student-platform" && o.renotify === true);
  }

  // an incoming call keeps its own, stronger behaviour
  {
    const w = bootSw();
    await push(w, { title: "Incoming call", body: "x", tag: "student-platform-voice_call-1", requireInteraction: true, renotify: true, vibrate: [400, 200, 400, 200, 400] });
    const o = w.shown[0] && w.shown[0].opts;
    t("call: stays on screen until answered", o && o.requireInteraction === true);
    t("call: keeps its own vibration pattern", o && JSON.stringify(o.vibrate) === JSON.stringify([400, 200, 400, 200, 400]));
    t("call: renotifies", o && o.renotify === true && o.silent === false);
  }

  // a sender can still ask for a quiet replacement on purpose
  {
    const w = bootSw();
    await push(w, { title: "Hi", body: "x", tag: "t1", renotify: false });
    t("an explicit renotify:false is honoured", w.shown[0] && w.shown[0].opts.renotify === false);
  }

  // text that is not JSON, and an empty push
  {
    const w = bootSw();
    await push(w, {}, { text: "plain words" });
    const o = w.shown[0] && w.shown[0].opts;
    t("a plain-text push is shown with the same sound settings", w.shown.length === 1 && w.shown[0].title === "Student Platform" && o.body === "plain words" && o.renotify === true && o.silent === false);
  }
  {
    const w = bootSw();
    await push(w, undefined);
    t("a push with no data shows nothing", w.shown.length === 0);
  }

  // the version marker moved with the change (the file says to bump it)
  t("service worker version is v8 or later", Number((swCode.match(/student-platform-pwa-v(\d+)/) || [])[1]) >= 8);

  // ---- the open screen already shows it: quiet system alert + refresh the screen
  const live = { title: "New message in Batch Discussion", body: "Anil: hello", tag: "student-platform-group_message-m1", url: "/dashboard?discussion=b1", liveOn: "/discussion" };
  {
    const w = bootSw({ windows: [win("/discussion")] });
    await push(w, live);
    const o = w.shown[0] && w.shown[0].opts;
    t("on the chat screen: still shown (every push must show a notification)", w.shown.length === 1 && w.shown[0].title === "New message in Batch Discussion");
    t("on the chat screen: shown quietly (the screen's own pop is the only sound)", o && o.silent === true && o.renotify === false);
    t("on the chat screen: quiet means no vibration pattern (silent + vibrate is a TypeError)", o && o.vibrate === undefined);
    t("on the chat screen: the screen is told to refresh now", w.posted.some((m) => m.type === "sp_live" && m.liveOn === "/discussion" && m.to === 0));
    t("on the chat screen: its tag and tap target are kept", o && o.tag === "student-platform-group_message-m1" && o.data.url === "/dashboard?discussion=b1");
  }
  {
    const w = bootSw({ windows: [win("/discussion/")] });
    await push(w, live);
    t("a trailing slash is still the chat screen", w.shown[0].opts.silent === true);
  }
  {
    const w = bootSw({ windows: [win("/support")] });
    await push(w, { title: "Student Platform update", body: "The support team replied", tag: "student-platform-support_reply-q1", url: "/support", liveOn: "/support" });
    t("on the Support screen: a team reply is quiet and the screen refreshes", w.shown[0].opts.silent === true && w.posted.some((m) => m.type === "sp_live" && m.liveOn === "/support"));
  }
  for (const [label, windows] of [
    ["on another screen (Home)", [win("/dashboard")]],
    ["on the group CALL screen, which is not the chat", [win("/discussion/call")]],
    ["with the chat screen hidden", [win("/discussion", { visibilityState: "hidden" })]],
    ["with the chat screen open but not focused", [win("/discussion", { focused: false })]],
    ["with no window open at all", []],
    ["with the Support screen open for a chat message", [win("/support")]],
  ]) {
    const w = bootSw({ windows });
    await push(w, live);
    const o = w.shown[0] && w.shown[0].opts;
    t(`${label}: the system alert still sounds`, w.shown.length === 1 && o.silent === false && o.renotify === true && Array.isArray(o.vibrate) && o.vibrate.length >= 1);
    t(`${label}: no screen is told to refresh`, !w.posted.some((m) => m.type === "sp_live"));
  }
  {
    const w = bootSw({ windows: [win("/dashboard"), win("/discussion"), win("/discussion", { visibilityState: "hidden" })] });
    await push(w, live);
    t("only the window that is on the chat screen is told to refresh", w.posted.filter((m) => m.type === "sp_live").length === 1 && w.posted.find((m) => m.type === "sp_live").to === 1);
  }
  {
    const w = bootSw({ windows: [win("/discussion")] });
    await push(w, { title: "Payment update", body: "Approved", tag: "student-platform-payment_approved-p1", url: "/payments" });
    t("a push the screen does not show live (no liveOn) keeps its system sound even with the chat open", w.shown[0].opts.silent === false && w.shown[0].opts.renotify === true && !w.posted.some((m) => m.type === "sp_live"));
  }
  for (const bad of ["https://evil.example/discussion", "javascript:1", "discussion", "", 5, null, {}]) {
    const w = bootSw({ windows: [win("/discussion")] });
    await push(w, { ...live, liveOn: bad });
    t(`a liveOn that is not an in-app path (${JSON.stringify(bad)}) is ignored`, w.shown[0].opts.silent === false && !w.posted.some((m) => m.type === "sp_live"));
  }
  {
    const w = bootSw({ windows: [win("/discussion")], matchAllFails: true });
    await push(w, live);
    t("if the worker cannot look at the open windows it falls back to the normal sounding alert", w.shown.length === 1 && w.shown[0].opts.silent === false && w.shown[0].opts.renotify === true);
  }
  {
    const w = bootSw({ windows: [win("/discussion")] });
    await push(w, { title: "Your login code", body: "123456", tag: "login-otp", otp: "123456", liveOn: "/discussion" });
    t("a login code is still handed to the open window", w.posted.some((m) => m.type === "sp_login_otp" && m.otp === "123456"));
  }
}

// ---------------------------------------------------------------- part 2: the in-app chime
const jitiFor = () => require("jiti")(path.join(root, "x.cjs"), {
  alias: { "@": path.join(root, "src") }, interopDefault: true, requireCache: false, cache: false,
});

let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;

function makeBrowser({ visible = true, audio = true, store = {}, storageThrows = false, ctxState = "running", resume = "ok" } = {}) {
  const log = { contexts: [], listeners: {}, removed: [] };
  const storage = storageThrows
    ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } }
    : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  class Param { constructor() { this.calls = []; } setValueAtTime(v, at) { this.calls.push(["set", v, at]); } exponentialRampToValueAtTime(v, at) { this.calls.push(["ramp", v, at]); } }
  class Ctx {
    constructor() {
      this.state = ctxState; this.currentTime = 5; this.destination = { isDestination: true };
      this.oscillators = []; this.gains = []; this.resumed = 0; log.contexts.push(this);
    }
    createOscillator() { const o = { type: "", frequency: { value: 0 }, connect(n) { o.to = n; }, start(at) { o.startAt = at; }, stop(at) { o.stopAt = at; } }; this.oscillators.push(o); return o; }
    createGain() { const g = { gain: new Param(), connect(n) { g.to = n; } }; this.gains.push(g); return g; }
    resume() {
      this.resumed++;
      if (resume === "ok") return Promise.resolve().then(() => { this.state = "running"; });
      if (resume === "never") return new Promise(() => {});
      if (typeof resume === "function") return resume(this);
      return Promise.reject(new Error("needs a tap first"));
    }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  const win = {
    localStorage: storage,
    addEventListener: (type, fn) => { (log.listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { log.removed.push(type); log.listeners[type] = (log.listeners[type] || []).filter((f) => f !== fn); },
  };
  if (audio) win.AudioContext = Ctx;
  globalThis.window = win;
  globalThis.document = { visibilityState: visible ? "visible" : "hidden" };
  return { win, log, store };
}

const tick = () => new Promise((r) => setImmediate(r));
const frequencies = (c) => c.oscillators.map((o) => o.frequency.value);

async function soundTests() {
  const load = () => jitiFor()("@/lib/notification-sound");

  // the on/off switch is remembered, on by default
  {
    const b = makeBrowser();
    const s = load();
    t("sounds are on by default", s.soundEnabled() === true);
    s.setSoundEnabled(false);
    t("switching off is remembered", b.store.sp_sound === "off" && s.soundEnabled() === false);
    s.setSoundEnabled(true);
    t("switching back on removes the mark", !("sp_sound" in b.store) && s.soundEnabled() === true);
  }
  {
    makeBrowser({ storageThrows: true });
    const s = load();
    let threw = false;
    try { s.setSoundEnabled(false); s.soundEnabled(); s.playChime(); } catch { threw = true; }
    t("blocked storage never breaks anything (sound stays on)", !threw && s.soundEnabled() === true);
  }

  // when it must stay silent
  {
    const b = makeBrowser({ store: { sp_sound: "off" } });
    const s = load();
    t("switched off: no sound and no audio engine created", s.playChime() === false && b.log.contexts.length === 0);
    t("switched off: even the test button stays quiet", s.playChime({ test: true }) === false && b.log.contexts.length === 0);
  }
  {
    const b = makeBrowser({ visible: false });
    const s = load();
    t("page hidden: no sound (the phone's own notification covers it)", s.playChime() === false && b.log.contexts.length === 0);
  }
  {
    makeBrowser({ audio: false });
    const s = load();
    let threw = false, r;
    try { r = s.playChime(); } catch { threw = true; }
    t("a browser without Web Audio: quietly does nothing", !threw && r === false);
  }
  {
    delete globalThis.window; delete globalThis.document;
    const s = load();
    let threw = false;
    try { s.playChime(); s.installAudioUnlock(); s.soundEnabled(); s.setSoundEnabled(true); } catch { threw = true; }
    t("on the server (no window) every function is safe", !threw && s.playChime() === false);
  }

  // the sound itself
  {
    const b = makeBrowser();
    const s = load();
    clock += 10_000;
    const started = s.playChime();
    const c = b.log.contexts[0];
    t("plays when on and visible", started === true && b.log.contexts.length === 1);
    t("two notes: G5 then C6", c && c.oscillators.length === 2 && frequencies(c)[0] === 784 && frequencies(c)[1] === 1047);
    t("each note goes through a gain to the speaker", c && c.oscillators.every((o, i) => o.to === c.gains[i] && c.gains[i].to === c.destination));
    t("it is quiet (peak gain at most 0.2)", c && c.gains.every((g) => g.gain.calls.every(([, v]) => v <= 0.2)));
    t("it fades in and out (no click): starts near zero", c && c.gains.every((g) => g.gain.calls[0][1] < 0.01));
    t("it is short (under half a second end to end)", c && Math.max(...c.oscillators.map((o) => o.stopAt)) - c.currentTime < 0.5);
    t("notes are scheduled slightly ahead of the audio clock", c && c.oscillators.every((o) => o.startAt > c.currentTime));

    // the one-per-1.2s rule
    t("a second message right after stays silent (a burst makes one sound)", s.playChime() === false && c.oscillators.length === 2);
    t("the test button is not held back by that gap", s.playChime({ test: true }) === true && c.oscillators.length === 4);
    clock += 1_300;
    t("after the gap the next message sounds again", s.playChime() === true && c.oscillators.length === 6);
    t("one audio engine is reused for every sound", b.log.contexts.length === 1);
  }

  // an audio engine the browser has not let start yet
  {
    const b = makeBrowser({ ctxState: "suspended", resume: "ok" });
    const s = load();
    clock += 10_000;
    s.playChime();
    const c = b.log.contexts[0];
    await tick();
    t("asleep engine: it is woken up, then the sound plays", c.resumed >= 1 && c.oscillators.length === 2);
  }
  {
    const b = makeBrowser({ ctxState: "suspended", resume: "reject" });
    const s = load();
    clock += 10_000;
    let threw = false;
    try { s.playChime(); await tick(); } catch { threw = true; }
    t("engine refuses to start (no tap yet): nothing plays, nothing throws", !threw && b.log.contexts[0].oscillators.length === 0);
  }
  {
    let release;
    const b = makeBrowser({ ctxState: "suspended", resume: (ctx) => new Promise((res) => { release = () => { ctx.state = "running"; res(); }; }) });
    const s = load();
    clock += 10_000;
    s.playChime();
    clock += 5_000; // the first tap only comes much later
    release();
    await tick();
    t("a sound that could only start 5s late is dropped, not played as a surprise", b.log.contexts[0].oscillators.length === 0);
  }

  // waking the engine on the first touch
  {
    const b = makeBrowser({ ctxState: "suspended", resume: "ok" });
    const s = load();
    s.installAudioUnlock();
    s.installAudioUnlock(); // calling it from several screens installs it once
    t("listens for the first touch / key / click", ["pointerdown", "touchend", "keydown", "click"].every((e) => (b.log.listeners[e] || []).length === 1));
    b.log.listeners.pointerdown[0]();
    await tick();
    t("the first touch wakes the audio engine", b.log.contexts.length === 1 && b.log.contexts[0].resumed === 1);
    t("and the listeners remove themselves", ["pointerdown", "touchend", "keydown", "click"].every((e) => (b.log.listeners[e] || []).length === 0));
  }
  {
    const b = makeBrowser({ store: { sp_sound: "off" }, ctxState: "suspended" });
    const s = load();
    s.installAudioUnlock();
    b.log.listeners.click[0]();
    t("sounds off: the first touch creates no audio engine", b.log.contexts.length === 0);
  }
}

// ---------------------------------------------------------------- part 3: how the screens use it
function wiringTests() {
  const discussion = read("src/app/discussion/page.tsx");
  t("discussion: imports the chime", /import \{[^}]*playChime[^}]*\} from "@\/lib\/notification-sound"/.test(discussion));
  t("discussion: only another person's message makes a sound", /sender_id !== myId/.test(discussion) && /fresh\.some\(/.test(discussion));
  t("discussion: the 'X just paid' notices stay silent", /sender_role !== "system"/.test(discussion));
  t("discussion: admin preview stays silent", /!previewMode && fresh\.some/.test(discussion));
  t("discussion: the first load only takes a snapshot", /heardRef\.current === null/.test(discussion) && /new Set\(confirmed\.map/.test(discussion));
  t("discussion: a failed first load takes no snapshot", /loadedOkRef\.current = true/.test(discussion) && /!loadedOkRef\.current/.test(discussion));
  t("discussion: messages still being sent are not counted", /m\._status !== "sending"/.test(discussion));
  t("discussion: wakes the audio engine on the first touch", /installAudioUnlock\(\)/.test(discussion));
  t("discussion: the sound is never started inside a state updater", !/setMessages\([^)]*=>[^;]*playChime/.test(discussion));

  const support = read("src/app/support/page.tsx");
  t("support: imports the chime", /import \{[^}]*playChime[^}]*\} from "@\/lib\/notification-sound"/.test(support));
  t("support: only replies from the assistant or team count", /m\.sender !== "student"/.test(support));
  t("support: the first successful load only takes a snapshot", /heardRef\.current === null/.test(support) && /heardRef\.current = new Set\(incoming\)/.test(support));
  t("support: judged inside load(), after a successful response", support.indexOf("playChime()") > support.indexOf("async function load()") && support.indexOf("playChime()") < support.indexOf("setAllThreads(threads)"));
  t("support: another account's history never sounds like a new reply", /heardRef\.current = null;[^\n]*\n\s*setThread\(null\)/.test(support));
  t("support: wakes the audio engine on the first touch", /installAudioUnlock\(\)/.test(support));

  t("discussion: refreshes at once when the worker reports a live push", /e\.data\?\.type === "sp_live" && e\.data\.liveOn === "\/discussion"\) pollNew\(batchId\)/.test(discussion) && /serviceWorker\.removeEventListener\("message"/.test(discussion));
  t("support: loads at once when the worker reports a live push", /e\.data\?\.type === "sp_live" && e\.data\.liveOn === "\/support"\) void load\(\)/.test(support) && /serviceWorker\.removeEventListener\("message"/.test(support));

  const notif = read("src/lib/services/student-notifications.ts");
  t("server: a chat message names /discussion as its live screen", /type === "group_message" \? "\/discussion"/.test(notif));
  t("server: a support reply names /support as its live screen", /type === "support_reply" \? "\/support"/.test(notif));
  t("server: liveOn is sent with the push only when there is one", /\.\.\.\(liveOn \? \{ liveOn \} : \{\}\)/.test(notif));
  t("server: nothing else is marked live (payments, announcements, calls keep their system sound)", (notif.match(/liveOn = /g) || []).length === 1 && !/liveOn.*(payment|announcement|voice_call|court_order)/.test(notif.slice(notif.indexOf("const liveOn"), notif.indexOf("const liveOn") + 200)));

  const profile = read("src/app/profile/page.tsx");
  t("profile: shows the sound settings card", /SoundSettingsCard/.test(profile) && /import SoundSettingsCard from "@\/components\/student\/SoundSettingsCard"/.test(profile));

  const card = read("src/components/student/SoundSettingsCard.tsx");
  t("card: a real switch with a state and a name (screen readers)", /role="switch"/.test(card) && /aria-checked=\{on\}/.test(card) && /aria-labelledby="sound-switch-label"/.test(card) && /id="sound-switch-label"/.test(card));
  t("card: the switch is remembered through setSoundEnabled", /setSoundEnabled\(next\)/.test(card));
  t("card: turning it on lets you hear it at once", /if \(next\) playChime\(\{ test: true \}\)/.test(card));
  t("card: the test button is shown only while sounds are on", /\{on && \(/.test(card) && /Play a test/.test(card));
  t("card: the test raises a real notification with the same options as a push", /showNotification\("Test notification"/.test(card) && /renotify: true/.test(card) && /silent: false/.test(card));
  t("card: blocked notifications are explained, not hidden", /permission === "denied"/.test(card) && /phone's settings/.test(card));
  t("card: says the closed-app alert follows the phone's settings", /follow your phone&apos;s notification settings/.test(card));
  t("card: uses only the shared colour tokens (no faint greys)", !/#8e8e93|#9ca3af|#aeaeb2|#94a3b8|#007aff/i.test(card));

  const lib = read("src/lib/notification-sound.ts");
  t("module: mute is checked before anything is created", lib.indexOf("if (!soundEnabled()) return false;") > 0 && lib.indexOf("if (!soundEnabled()) return false;") < lib.indexOf("getContext();", lib.indexOf("export function playChime")));
  t("module: hidden pages are skipped", /document\.visibilityState !== "visible"/.test(lib));
  t("module: there is a minimum gap between sounds", /MIN_GAP_MS = 1200/.test(lib));
}

(async () => {
  try {
    await swTests();
    await soundTests();
    wiringTests();
  } finally {
    Date.now = realNow;
  }
  console.log(`test-notification-sound (${path.relative(root, swFile)}): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { Date.now = realNow; console.error("TEST ERROR", e); process.exit(1); });
