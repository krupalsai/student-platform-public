/**
 * Pins that both sides of an in-app call get a real, out-of-band alert —
 * not just a silent in-app banner.
 *
 * Live report: "when I try to call someone their phone not ringing". Traced
 * to prod data — a run of real admin-initiated callbacks, none of which ever
 * reached `accepted`, every one timed out or was hung up by its own caller.
 *
 * Root cause: student-originated calls alert every active super_admin over
 * WhatsApp (alertAdmins), but admin-initiated callbacks alerted the STUDENT
 * with nothing at all — no WhatsApp, no push. The in-app banner
 * (StudentCallButton) only shows if the student already has the app open and
 * polling, which is not a real substitute for a phone actually ringing. Even
 * when the tab WAS open, the banner was silent — no sound, no vibration —
 * unlike the admin side, which had just gained a ringtone.
 *
 *   node --experimental-strip-types scripts/test-call-notifications.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const callsRoute = readFileSync("src/app/api/calls/route.ts", "utf8");
const studentButton = readFileSync("src/components/call/StudentCallButton.tsx", "utf8");
const adminWatcher = readFileSync("src/components/admin/IncomingCallWatcher.tsx", "utf8");
const ringtoneHook = readFileSync("src/lib/hooks/useRingtone.ts", "utf8");
const notifications = readFileSync("src/lib/services/student-notifications.ts", "utf8");

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

// ── The callback branch must alert the student out-of-band ────────────────
const callbackBranch = callsRoute.slice(
  callsRoute.indexOf('if (body?.action === "callback")'),
  callsRoute.indexOf("if (!(await isVoiceCallsEnabled(db)))"),
);
ok(
  "the callback branch notifies the student, not just the caller's own response",
  callbackBranch.includes("notifyStudent"),
  "without this, the student who is being called back has no way to know unless the app happens to be open",
);
ok(
  "the student notification fires for a NEWLY created call, not only a resumed one",
  callbackBranch.indexOf("notifyStudent") > callbackBranch.indexOf(".insert({"),
  "a resumed call was already notified when first created — notifying again on resume would be a duplicate, not a fix",
);

// ── Both incoming-call surfaces use the shared ringtone, not a silent banner ──
for (const [label, src] of [["StudentCallButton", studentButton], ["IncomingCallWatcher", adminWatcher]] as const) {
  ok(`${label} plays the ringtone`, src.includes("useRingtone("));
}

// ── The ringtone hook itself does what it claims ──────────────────────────
ok("the ringtone hook vibrates", ringtoneHook.includes("navigator.vibrate"));
ok("the ringtone hook uses Web Audio, not an asset fetch", ringtoneHook.includes("AudioContext"));
ok(
  "the ringtone is keyed by call id, so a second call rings again",
  /if \(rungForRef\.current === callId\) return;/.test(ringtoneHook),
  "a bare boolean would treat a second incoming call as already-ringing and stay silent",
);
ok(
  "the ringtone stops when nothing is ringing",
  /if \(!callId\)[\s\S]{0,80}?stop\(\);/.test(ringtoneHook),
);

// ── voice_call alerts must not gate WhatsApp behind push's self-reported
// "ok" ──────────────────────────────────────────────────────────────────
// Live report, after ringtone/screen/accept-guard were all already fixed:
// "Placed a call, other side never rang/answered." Root cause: `sendPushFirst`
// returns true the instant FCM/webpush ACCEPTS the request, not once the
// device actually shows anything — so a stale subscription or a silently
// dropped showNotification() still reports "delivered," and the WhatsApp
// fallback (which would genuinely have reached the phone) never fires. Same
// root cause as item #146's login-OTP fix, this time blocking calls instead.
const notifyStudentBody = notifications.slice(
  notifications.indexOf("export async function notifyStudent"),
);
ok(
  "a voice_call alert sends push AND WhatsApp together, not one gated on the other's self-reported success",
  /type === "voice_call"[\s\S]{0,300}Promise\.allSettled/.test(notifyStudentBody),
  "sendPushFirst reporting ok:true does not mean the device showed anything — a call's 60s window can't wait on that being wrong",
);

console.log(`test-call-notifications: all ${passed} assertions passed`);
