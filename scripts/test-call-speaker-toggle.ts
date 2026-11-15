/**
 * Pins the speaker toggle added to the in-call screen.
 *
 * Live report: "There is no speaker option at the calling section" —
 * CallOverlay only ever had Mute and End; there was no way to switch the
 * call audio toward the loudspeaker at all.
 *
 * There is no web API to move audio between a phone's earpiece and its
 * loudspeaker outright — that is native hardware audio-focus routing, and a
 * page cannot touch it. setSinkId is the closest real lever (Android Chrome
 * exposes a distinct "Speaker" output device; iOS Safari does not implement
 * setSinkId at all). This fails soft everywhere it can't act, same posture
 * as the TURN/ringtone code — so pin that it degrades rather than throws,
 * not that it works on every platform, which nothing here can promise.
 *
 *   node --experimental-strip-types scripts/test-call-speaker-toggle.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const hook = readFileSync("src/lib/hooks/useVoiceCall.ts", "utf8");
const overlay = readFileSync("src/components/call/CallOverlay.tsx", "utf8");
const adminWatcher = readFileSync("src/components/admin/IncomingCallWatcher.tsx", "utf8");
const studentButton = readFileSync("src/components/call/StudentCallButton.tsx", "utf8");

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

// ── The hook exposes real, wired state and an action ───────────────────────
ok("the hook tracks speaker state", /const \[speakerOn, setSpeakerOn\] = useState/.test(hook));
ok("the hook exposes a toggle", hook.includes("toggleSpeaker"));
ok(
  "speaker state resets on teardown, same as mute",
  /setMuted\(false\);\s*\n\s*setSpeakerOn\(false\);/.test(hook),
  "otherwise a preference from one call would silently carry into the next",
);

// ── The toggle attempts real output routing, never throws past it ─────────
ok(
  "the toggle uses setSinkId, the real output-routing API, not a fake",
  hook.includes("setSinkId"),
);
ok(
  "an unsupported browser degrades silently instead of erroring",
  /catch \{[\s\S]{0,160}?\/\/ Unsupported/.test(hook),
  "iOS Safari has no setSinkId at all — this must not surface as a call-breaking error",
);

// ── The overlay actually renders and wires the control ─────────────────────
ok("CallOverlay takes speakerOn", overlay.includes("speakerOn"));
ok("CallOverlay takes onToggleSpeaker", overlay.includes("onToggleSpeaker"));
ok("CallOverlay renders a Speaker-labeled control", /caption="Speaker"/.test(overlay));

// ── Both real call surfaces pass the new props through, not just one ──────
for (const [label, src] of [["IncomingCallWatcher", adminWatcher], ["StudentCallButton", studentButton]] as const) {
  ok(`${label} passes speakerOn to CallOverlay`, /speakerOn=\{call\.speakerOn\}/.test(src));
  ok(`${label} passes onToggleSpeaker to CallOverlay`, /onToggleSpeaker=\{call\.toggleSpeaker\}/.test(src));
}

console.log(`test-call-speaker-toggle: all ${passed} assertions passed`);
