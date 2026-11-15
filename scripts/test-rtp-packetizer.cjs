// 2026-10-18: the first real call to the in-app AI assistant connected, the timer ran, the caller
// was heard (three turns are in call_events) and answered — and the bot never made a sound. The
// media server handed werift a BARE Opus frame, writeRtp() expects a finished RTP packet, and a
// bare frame is parsed as nonsense and dropped without an error. Reproduced with real Chromium as
// the caller and the real server: 0 packets arrived. With each frame wrapped in a proper RTP
// packet, 150 arrived, none lost, no concealment while the tone played.
//
// Pins: (1) the packetiser's arithmetic (sequence, timestamp, marker, pauses) with stand-ins for
// werift's classes; (2) the wiring, so the server cannot go back to sending bare frames; (3) that
// speak() paces against the clock and pads the last frame (real CallSession, a stand-in Piper);
// (4) when the media server's dependencies are installed, the real two-peer loopback self-test.
// Run: node scripts/test-rtp-packetizer.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const load = (f) => import(pathToFileURL(path.join(__dirname, "..", f)).href);

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) pass++; else { fail++; console.error("FAIL:", name); } };

// Stand-ins that just keep what they are given.
class FakeHeader { constructor(o) { Object.assign(this, o); } }
class FakePacket { constructor(header, payload) { this.header = header; this.payload = payload; } }

(async () => {
  const { createRtpPacketizer } = await load("media-server/src/rtp.js");

  // A clock and a "random" we control. random() * 65536 and * 2^32 floor to the values below.
  function make({ seq = 100, ts = 5000, start = 1_000_000 } = {}) {
    let clock = start;
    const values = [(seq + 0.5) / 0x10000, (ts + 0.5) / 0x100000000];
    let k = 0;
    const p = createRtpPacketizer({ RtpHeader: FakeHeader, RtpPacket: FakePacket, now: () => clock, random: () => values[k++ % 2] });
    return { p, advance: (ms) => { clock += ms; } };
  }
  const payload = Buffer.from([1, 2, 3]);

  // ---- 1. the arithmetic ---------------------------------------------------------------------
  {
    const { p, advance } = make({ seq: 100, ts: 5000 });
    const a = p.packet(payload);
    t("a packet carries the frame it was given", a instanceof FakePacket && a.payload === payload);
    t("RTP version 2, SSRC left for the sender to fill in", a.header.version === 2 && a.header.ssrc === 0);
    t("it starts from the (random) initial sequence number and timestamp", a.header.sequenceNumber === 100 && a.header.timestamp === 5000);
    t("the first packet of the call is marked as the start of speech", a.header.marker === true);

    advance(20);
    const b = p.packet(payload);
    advance(20);
    const c = p.packet(payload);
    t("sequence numbers go up by one", b.header.sequenceNumber === 101 && c.header.sequenceNumber === 102);
    t("timestamps go up by one frame (960 ticks of the 48 kHz clock)", b.header.timestamp === 5960 && c.header.timestamp === 6920);
    t("only the first packet of a burst is marked", b.header.marker === false && c.header.marker === false);

    advance(23);                                    // a late timer is not a pause
    const d = p.packet(payload);
    advance(60);                                    // exactly three frames: still not a pause
    const e = p.packet(payload);
    t("ordinary timer lateness (up to 60 ms) is not treated as a pause", d.header.marker === false && e.header.marker === false && e.header.timestamp === d.header.timestamp + 960);
    advance(61);
    const f = p.packet(payload);
    t("just over three frames of silence starts a new burst", f.header.marker === true);
  }
  {
    const { p, advance } = make({ seq: 7, ts: 100000 });
    const a = p.packet(payload);
    advance(20); p.packet(payload);
    advance(2000);                                  // the caller talks for two seconds; we send nothing
    const afterPause = p.packet(payload);
    t("after a pause the media clock jumps by the real time that passed (2000 ms = 96000 ticks)", afterPause.header.timestamp - a.header.timestamp === 20 * 48 + 2000 * 48);
    t("...and the first packet after it is marked", afterPause.header.marker === true);
    t("...while the sequence number just carries on", afterPause.header.sequenceNumber === 9);
    advance(20);
    const next = p.packet(payload);
    t("the next packet is back to one frame at a time, unmarked", next.header.timestamp - afterPause.header.timestamp === 960 && next.header.marker === false);
  }
  {
    const { p, advance } = make({ seq: 0xfffe, ts: 0xfffffc00 });
    const a = p.packet(payload); advance(20);
    const b = p.packet(payload); advance(20);
    const c = p.packet(payload);
    t("the sequence number wraps at 65535", a.header.sequenceNumber === 0xfffe && b.header.sequenceNumber === 0xffff && c.header.sequenceNumber === 0);
    t("the timestamp wraps at 2^32", b.header.timestamp === (0xfffffc00 + 960) >>> 0 && c.header.timestamp === ((0xfffffc00 + 1920) >>> 0));
  }

  // ---- 2. the wiring -------------------------------------------------------------------------
  const idx = read("media-server/src/index.js");
  const ses = read("media-server/src/session.js");
  const rtp = read("media-server/src/rtp.js");
  const pkg = JSON.parse(read("media-server/package.json"));
  t("index.js imports werift's RTP classes", /import \{[^}]*\bRtpHeader\b[^}]*\bRtpPacket\b[^}]*\} from "werift";/.test(idx));
  t("index.js builds one packetiser per call", /const packetizer = createRtpPacketizer\(\{ RtpHeader, RtpPacket \}\);/.test(idx));
  t("audio goes out as a packet, not a bare frame", /outTrack\.writeRtp\(packetizer\.packet\(encoded\)\);/.test(idx));
  t("nothing hands writeRtp a bare Opus frame any more", !/writeRtp\(encoded\)|writeRtp\(encoder\.encode/.test(idx));
  t("rtp.js has no dependencies of its own", !/^\s*import\s/m.test(rtp));
  t("the loopback self-test exists and has an npm script", fs.existsSync(path.join(__dirname, "../media-server/src/selftest-rtp.js")) && pkg.scripts && pkg.scripts["selftest:rtp"] === "node src/selftest-rtp.js");
  t("session.js paces against the clock", /startedAt \+ sent \* FRAME_MS - Date\.now\(\)/.test(ses));
  t("...and no longer sleeps a flat 20 ms per frame", !/await sleep\(FRAME_MS\)/.test(ses));
  t("...and pads the last, partial frame for the encoder", /Buffer\.alloc\(frameBytes\)/.test(ses));

  // ---- 3. speak() with the real CallSession --------------------------------------------------
  // Stand-in Piper: ignores its arguments and writes 66,250 samples (3.004 s) of 22.05 kHz mono.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-test-"));
  const fakePiper = path.join(tmp, "fake-piper.js");
  fs.writeFileSync(fakePiper, `#!/usr/bin/env node
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  const n = 66250, b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 22050)), i * 2);
  process.stdout.write(b, () => process.exit(0));
});
`);
  fs.chmodSync(fakePiper, 0o755);
  process.env.PIPER_BIN = fakePiper;
  process.env.PIPER_VOICE = "fake.onnx";
  process.env.PIPER_SAMPLE_RATE = "22050";
  try {
    const { CallSession } = await load("media-server/src/session.js");
    const realInfo = console.info; console.info = () => {};
    const frames = [];
    const s = new CallSession({ callId: "app-pace-1", caller: "9000000001", channel: "app", sendAudio: (f) => frames.push({ at: Date.now(), len: f.length }), onEnd: async () => {} });
    // Every real timer fires a little late. Make that lateness a sure 2 ms, so the test checks the
    // property that matters (a sender that makes up for it) instead of this machine's timer precision.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, typeof ms === "number" && ms >= 5 ? ms + 2 : ms, ...rest);
    try { await s.speak("hello"); } finally { global.setTimeout = realSetTimeout; }
    await s.end("completed");
    console.info = realInfo;

    const frameBytes = 48 * 20 * 2;                       // 20 ms of 48 kHz mono, 16-bit
    t("the reply is sent as 151 frames", frames.length === 151);
    t("every frame is a whole 20 ms frame (the last one is padded)", frames.length > 0 && frames.every((f) => f.len === frameBytes));
    const span = frames[frames.length - 1].at - frames[0].at;
    const ideal = (frames.length - 1) * 20;
    t(`the send rate does not drift (last frame ${span} ms after the first, ideal ${ideal})`, Math.abs(span - ideal) <= 50);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- 4. the real loopback, when the server's dependencies are installed --------------------
  const deps = fs.existsSync(path.join(__dirname, "../media-server/node_modules/werift"));
  if (deps) {
    const r = spawnSync(process.execPath, [path.join(__dirname, "../media-server/src/selftest-rtp.js")], { encoding: "utf8", timeout: 90_000 });
    t("the two-peer loopback self-test passes (audio reaches the caller)", r.status === 0);
    if (r.status !== 0) console.error((r.stdout || "") + (r.stderr || ""));
  } else {
    console.log("(loopback self-test skipped: run `npm ci` in media-server/ to include it)");
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
