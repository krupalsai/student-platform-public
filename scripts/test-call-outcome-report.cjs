// 2026-10-18: "check the voice server" found that a call's outcome (when it ended, how long,
// turns, transcript, why) was never reported to the platform when the call was ended from
// OUTSIDE the session: the student tapping End (/hangup), the connection dropping, the process
// shutting down. end() built the summary and called onEnd, which re-entered teardown; that inner
// call returned at once because the outer call had already removed the call from `sessions`, and
// the outer call had no summary of its own. Only calls the session ended itself (silence, too
// long, too many turns) were ever reported.
//
// This drives the REAL CallSession and the REAL teardown, wired the way startCall() in
// media-server/src/index.js wires them, with a recording stand-in for the network call.
// Run: node scripts/test-call-outcome-report.cjs
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const load = (f) => import(pathToFileURL(path.join(__dirname, "..", f)).href);

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) pass++; else { fail++; console.error("FAIL:", name); } };

const quiet = { info() {}, error() {}, warn() {} };

(async () => {
  const { createTeardown } = await load("media-server/src/teardown.js");
  const { CallSession } = await load("media-server/src/session.js");

  // CallSession logs its own ending with console.info; keep the test output readable.
  const realInfo = console.info;
  console.info = () => {};

  // One call, built exactly the way startCall() builds it: the session's onEnd re-enters
  // teardown with the summary it has just made.
  function harness({ report } = {}) {
    const sessions = new Map();
    const reports = [];
    const reportOutcome = report ?? (async (s) => { reports.push(s); });
    const teardown = createTeardown({ sessions, reportOutcome, log: quiet });
    let seq = 0;
    function startCall({ pcCloseThrows = false } = {}) {
      const callId = `app-test-${++seq}`;
      const entry = {
        callId, closed: 0, session: null,
        pc: { close: async () => { entry.closed++; if (pcCloseThrows) throw new Error("close failed"); } },
      };
      sessions.set(callId, entry);
      entry.session = new CallSession({
        callId, caller: "9000000001", channel: "app", sendAudio() {},
        onEnd: async (summary) => { await teardown(entry, summary.reason, summary); },
      });
      return entry;
    }
    return { sessions, reports, teardown, startCall };
  }

  // ---- 1. the student taps End (/hangup) -----------------------------------------------------
  {
    const h = harness();
    const e = h.startCall();
    e.session.turns = 3;
    e.session.transcript.push({ q: "hello", a: "hi" });
    await h.teardown(e, "remote_hangup");
    const r = h.reports[0] || {};
    t("a call ended by /hangup is reported", h.reports.length === 1);
    t("...with why it ended", r.reason === "remote_hangup");
    t("...and which call", r.callId === e.callId);
    t("...with its turns and transcript", r.turns === 3 && Array.isArray(r.transcript) && r.transcript.length === 1);
    t("...and how long it lasted", typeof r.durationMs === "number" && r.durationMs >= 0);
    t("the call is removed and the connection closed once", h.sessions.size === 0 && e.closed === 1);
    t("the session itself is ended", e.session.ended === true);
  }

  // ---- 2. the connection drops ---------------------------------------------------------------
  for (const reason of ["ice_failed", "ice_closed", "ice_disconnected"]) {
    const h = harness();
    const e = h.startCall();
    await h.teardown(e, reason);
    t(`a call ended by ${reason} is reported once with that reason`, h.reports.length === 1 && h.reports[0].reason === reason);
    t(`${reason}: connection closed once`, e.closed === 1 && h.sessions.size === 0);
  }

  // ---- 3. the process shuts down with calls open ---------------------------------------------
  {
    const h = harness();
    const calls = [h.startCall(), h.startCall(), h.startCall()];
    for (const e of [...h.sessions.values()]) await h.teardown(e, "shutdown");
    t("every open call is reported on shutdown", h.reports.length === 3 && h.reports.every((r) => r.reason === "shutdown"));
    t("...each exactly once", new Set(h.reports.map((r) => r.callId)).size === 3);
    t("...and all are closed", calls.every((e) => e.closed === 1) && h.sessions.size === 0);
  }

  // ---- 4. the session ends itself (this always worked; it must not regress or double up) ------
  for (const reason of ["silence_timeout", "max_duration", "max_turns", "stt_failed"]) {
    const h = harness();
    const e = h.startCall();
    await e.session.end(reason);
    t(`a call the session ends itself (${reason}) is reported once`, h.reports.length === 1 && h.reports[0].reason === reason);
    t(`${reason}: closed once and removed`, e.closed === 1 && h.sessions.size === 0);
  }

  // ---- 5. whichever ending comes first wins; nothing is reported twice ------------------------
  {
    const h = harness();
    const e = h.startCall();
    await h.teardown(e, "remote_hangup");
    await h.teardown(e, "ice_closed");           // the connection closing after the hangup
    await e.session.end("silence_timeout");      // a late timer
    t("a second ending after the first changes nothing", h.reports.length === 1 && h.reports[0].reason === "remote_hangup" && e.closed === 1);
  }
  {
    const h = harness();
    const e = h.startCall();
    await Promise.all([h.teardown(e, "remote_hangup"), h.teardown(e, "ice_closed")]);
    t("a hangup racing a dropped connection reports once", h.reports.length === 1 && e.closed === 1);
  }

  // ---- 6. a failing report, or a failing close, never gets in the way -------------------------
  {
    let tried = 0;
    const h = harness({ report: async () => { tried++; throw new Error("platform down"); } });
    const e = h.startCall();
    let threw = false;
    try { await h.teardown(e, "remote_hangup"); } catch { threw = true; }
    t("a report that fails does not throw out of teardown", !threw && tried === 1);
    t("...and the connection is still closed", e.closed === 1 && h.sessions.size === 0);
  }
  {
    const h = harness();
    const e = h.startCall({ pcCloseThrows: true });
    await h.teardown(e, "remote_hangup");
    t("a connection that fails to close does not stop the report", h.reports.length === 1 && h.reports[0].reason === "remote_hangup");
  }

  // ---- 7. odd entries ------------------------------------------------------------------------
  {
    const h = harness();
    const entry = { callId: "app-nosession", session: null, closed: 0, pc: { close: async () => { entry.closed++; } } };
    h.sessions.set(entry.callId, entry);
    await h.teardown(entry, "remote_hangup");
    t("a call with no session has nothing to report and is still cleaned up", h.reports.length === 0 && entry.closed === 1 && h.sessions.size === 0);
  }
  {
    const h = harness();
    const entry = { callId: "app-broken", closed: 0, pc: { close: async () => { entry.closed++; } }, session: { end: async () => { throw new Error("boom"); } } };
    h.sessions.set(entry.callId, entry);
    const summary = { callId: entry.callId, reason: "silence_timeout", durationMs: 1, turns: 0, transcript: [] };
    await h.teardown(entry, "silence_timeout", summary);
    t("if end() throws, the summary that was passed in is still reported", h.reports.length === 1 && h.reports[0] === summary);
  }

  // ---- 8. end() hands back its summary once --------------------------------------------------
  {
    const s = new CallSession({ callId: "app-end", caller: "9000000001", channel: "app", sendAudio() {}, onEnd: async () => {} });
    const first = await s.end("remote_hangup");
    const second = await s.end("silence_timeout");
    t("end() returns the summary the first time", first && first.callId === "app-end" && first.reason === "remote_hangup" && typeof first.durationMs === "number");
    t("...and nothing the second time", second === undefined);
  }

  console.info = realInfo;

  // ---- 9. the wiring in the server, which this test cannot import (it starts listening) -------
  const idx = read("media-server/src/index.js");
  const ses = read("media-server/src/session.js");
  const td = read("media-server/src/teardown.js");
  t("index.js uses the shared teardown", /import \{ createTeardown \} from "\.\/teardown\.js";/.test(idx) && /const teardown = createTeardown\(\{ sessions, reportOutcome \}\);/.test(idx));
  t("index.js has no second, inline teardown", !/function teardown\(/.test(idx));
  t("the session's onEnd still re-enters teardown with its summary", /onEnd: async \(summary\) => \{ await teardown\(entry, summary\.reason, summary\); \}/.test(idx));
  t("/hangup still waits for the teardown", /if \(entry\) await teardown\(entry, "remote_hangup"\);/.test(idx));
  t("a dropped connection still goes through teardown", /teardown\(entry, `ice_\$\{state\}`\)/.test(idx));
  t("shutdown still tears each call down", /await teardown\(entry, "shutdown"\)/.test(idx));
  t("the outcome is still posted to the platform, signed", /\/api\/whatsapp\/call-outcome/.test(idx) && /"X-Signature": sig/.test(idx));
  t("the outcome request cannot hold a hangup or a shutdown open", /signal: AbortSignal\.timeout\(8000\)/.test(idx));
  t("the phone-line transport still reports its own way", /attachTelephony\(server, \{ onOutcome: reportOutcome \}\)/.test(idx));
  t("teardown takes the summary from end() when none was passed", /\(await entry\.session\?\.end\(reason\)\) \?\? summary/.test(td));
  t("teardown only acts for the first caller", /if \(!sessions\.has\(entry\.callId\)\) return;/.test(td));
  t("end() hands its summary back", /await this\.onEnd\?\.\(summary\);[^\n]*\n\s*return summary;/.test(ses));

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
