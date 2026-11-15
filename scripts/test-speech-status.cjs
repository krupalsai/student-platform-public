// 2026-10-18: the first real call to the in-app AI assistant was silent, and nothing on the server
// said why: a missing Piper voice, a broken Piper or a missing Groq key all look the same from
// outside (the caller is heard, and never answered aloud). The media server now remembers what its
// last text-to-speech attempt did and reports it on /health, and tries once at startup; admin
// Health shows it. This drives the REAL pipeline.js with stand-in Piper programs.
// Run: node scripts/test-speech-status.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) pass++; else { fail++; console.error("FAIL:", name); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "speech-test-"));
let n = 0;
// pipeline.js reads its settings when it is loaded, so each scenario loads a fresh copy
// (a different query string makes Node treat it as a new module).
async function fresh(env) {
  for (const k of ["GROQ_API_KEY", "PIPER_BIN", "PIPER_VOICE", "PIPER_VOICE_TE"]) delete process.env[k];
  Object.assign(process.env, env);
  return import(pathToFileURL(path.join(__dirname, "../media-server/src/pipeline.js")).href + `?scenario=${++n}`);
}
function script(name, body) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}
const goodPiper = script("good.js", `
process.stdin.on("data", () => {});
process.stdin.on("end", () => { const b = Buffer.alloc(4410 * 2, 1); process.stdout.write(b, () => process.exit(0)); });`);
const failingPiper = script("failing.js", `
process.stdin.on("data", () => {});
process.stdin.on("end", () => { process.stderr.write("could not load model /opt/piper/voices/en_US-amy-medium.onnx"); process.exit(1); });`);
// fails while a flag file exists, works once it is gone — to see the error clear itself
const flag = path.join(tmp, "broken.flag");
const flakyPiper = script("flaky.js", `
const fs = require("fs");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  if (fs.existsSync(${JSON.stringify(flag)})) { process.stderr.write("model busy"); process.exit(2); }
  process.stdout.write(Buffer.alloc(4410 * 2, 1), () => process.exit(0));
});`);

(async () => {
  try {
    // ---- 1. nothing configured -----------------------------------------------------------------
    {
      const p = await fresh({});
      let st = p.speechStatus();
      t("before anything is tried: not hearing, no voice, nothing known about speaking", st.stt_ready === false && st.tts_voice_set === false && st.tts_last_error === null && st.tts_last_ok_at === null);
      const r = await p.synthesise("hello");
      t("with no voice set, speaking fails and says why", r.pcm === null && r.error === "PIPER_VOICE not set");
      st = p.speechStatus();
      t("the status then reports that error", st.tts_last_error === "PIPER_VOICE not set" && st.tts_voice_set === false && st.tts_last_ok_at === null);
      const probe = await p.probeSpeech();
      t("the startup probe says it is not working, with the reason", probe.ok === false && probe.error === "PIPER_VOICE not set" && typeof probe.ms === "number");
    }

    // ---- 2. the Groq key -----------------------------------------------------------------------
    {
      const p = await fresh({ GROQ_API_KEY: "test-key-not-real" });
      t("a Groq key being set shows as ready to hear", p.speechStatus().stt_ready === true);
      t("...and the key itself is never part of the status", !JSON.stringify(p.speechStatus()).includes("test-key-not-real"));
    }

    // ---- 3. Piper working ----------------------------------------------------------------------
    {
      const p = await fresh({ PIPER_BIN: goodPiper, PIPER_VOICE: "voice.onnx" });
      const before = Date.now();
      const r = await p.synthesise("hello");
      const st = p.speechStatus();
      t("a working Piper returns audio", r.error === null && r.pcm && r.pcm.length === 4410 * 2);
      t("...and the status says so, with when", st.tts_voice_set === true && st.tts_last_error === null && st.tts_last_ok_at >= before && st.tts_last_ok_at <= Date.now());
      const probe = await p.probeSpeech();
      t("the startup probe reports ok", probe.ok === true && probe.error === null);
    }

    // ---- 4. Piper broken -----------------------------------------------------------------------
    {
      const p = await fresh({ PIPER_BIN: failingPiper, PIPER_VOICE: "voice.onnx" });
      const r = await p.synthesise("hello");
      const st = p.speechStatus();
      t("a Piper that exits with an error returns no audio", r.pcm === null && /piper exit 1/.test(r.error));
      t("the status keeps the cause", /piper exit 1/.test(st.tts_last_error) && st.tts_voice_set === true && st.tts_last_ok_at === null);
      t("...but not the server's file paths", !/\/opt\/piper/.test(st.tts_last_error) && /<path>/.test(st.tts_last_error));
    }
    {
      const p = await fresh({ PIPER_BIN: path.join(tmp, "does", "not", "exist"), PIPER_VOICE: "voice.onnx" });
      const r = await p.synthesise("hello");
      const st = p.speechStatus();
      t("a Piper program that is missing returns no audio", r.pcm === null && /piper/i.test(r.error));
      t("...and the status says it, without the path", /piper/i.test(st.tts_last_error) && !st.tts_last_error.includes(tmp));
    }

    // ---- 5. it recovers, and the status follows ------------------------------------------------
    {
      fs.writeFileSync(flag, "x");
      const p = await fresh({ PIPER_BIN: flakyPiper, PIPER_VOICE: "voice.onnx" });
      await p.synthesise("one");
      t("a failure is recorded", /piper exit 2/.test(p.speechStatus().tts_last_error || ""));
      fs.rmSync(flag);
      const r = await p.synthesise("two");
      const st = p.speechStatus();
      t("a later success clears the error and records the time", r.error === null && st.tts_last_error === null && typeof st.tts_last_ok_at === "number");
      fs.writeFileSync(flag, "x");
      await p.synthesise("three");
      const st2 = p.speechStatus();
      t("a new failure is recorded again but the last good time is kept", /piper exit 2/.test(st2.tts_last_error || "") && st2.tts_last_ok_at === st.tts_last_ok_at);
      fs.rmSync(flag);
    }

    // ---- 6. the wiring -------------------------------------------------------------------------
    const idx = read("media-server/src/index.js");
    t("/health reports the speech status", /speech: speechStatus\(\),/.test(idx));
    t("the server tries to speak once at startup and logs the result", /probeSpeech\(\)/.test(idx) && /\[startup\] speech output NOT working/.test(idx) && /\[startup\] speech output ok/.test(idx));
    t("a missing Groq key is logged at startup", /GROQ_API_KEY is not set — the bot cannot hear callers/.test(idx));
    t("session.js still speaks through the same function", /synthesise\(text, lang\)/.test(read("media-server/src/session.js")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(2); });
