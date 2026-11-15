/**
 * Pins the fix for two live reports on the same thread: "when calling it
 * not ringing on the receiver side, only just small message" and "multiple
 * calls total can't describe but not behaving properly".
 *
 * Root causes, both confirmed by reading the actual code rather than
 * guessed:
 *
 * 1. The ONLY visual a callee ever saw was a small card pinned to the top
 *    of whatever page happened to be open (StudentCallButton's
 *    `callbackIncoming` banner, IncomingCallWatcher's `top` banner) — easy
 *    to miss, nothing like a real incoming call. item #142's ringtone fix
 *    made the device actually ring/vibrate; this closes the matching visual
 *    gap with a real full-screen takeover (`IncomingCallScreen`), the same
 *    treatment every reference app (WhatsApp, the system dialer) gives an
 *    incoming call.
 * 2. When the app wasn't open at all, the receiver got exactly a plain OS
 *    push notification — generic title ("Student Platform update"), no
 *    vibrate pattern, no requireInteraction, so it could auto-dismiss in a
 *    few seconds without ever being noticed. That reads exactly like "only
 *    just small message". Fixed with a voice_call-specific title/vibrate/
 *    requireInteraction/renotify, honoured by the service worker.
 * 3. The admin banner only ever showed ONE ringing call (`incoming[0]`)
 *    with no indication that more than one student might be calling in at
 *    once — a second/third caller's ring would just silently sit unlisted
 *    until the first was handled. `queueCount` now surfaces "+N more
 *    waiting" instead of that silence.
 *
 *   node --experimental-strip-types scripts/test-incoming-call-screen.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const studentButton = readFileSync("src/components/call/StudentCallButton.tsx", "utf8");
const adminWatcher = readFileSync("src/components/admin/IncomingCallWatcher.tsx", "utf8");
const incomingScreen = readFileSync("src/components/call/IncomingCallScreen.tsx", "utf8");
const notifications = readFileSync("src/lib/services/student-notifications.ts", "utf8");
const sw = readFileSync("public/sw.js", "utf8");

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

// ── Both callee-facing surfaces use the real full-screen incoming call screen ──
for (const [label, src] of [["StudentCallButton", studentButton], ["IncomingCallWatcher", adminWatcher]] as const) {
  ok(`${label} renders IncomingCallScreen, not an inline banner`, src.includes("<IncomingCallScreen"));
}
ok(
  "StudentCallButton no longer builds its own banner markup",
  !studentButton.includes('role="alert"'),
  "the old inline top-card banner must be gone, not just supplemented",
);
ok(
  "IncomingCallWatcher no longer builds its own banner markup",
  !adminWatcher.includes('role="alert"'),
);

// ── The admin side surfaces a queue, not silence, when more than one call rings ──
ok(
  "IncomingCallWatcher passes how many OTHER calls are also ringing",
  /queueCount=\{call\.incoming\.length\s*-\s*1\}/.test(adminWatcher),
);
ok(
  "IncomingCallScreen actually renders the queue count when there is one",
  incomingScreen.includes("queueCount > 0") && incomingScreen.includes("more"),
);

// ── The screen is a real full-screen takeover, not another small card ──
ok(
  "IncomingCallScreen covers the whole viewport",
  incomingScreen.includes('position: "fixed", inset: 0'),
);
ok(
  "IncomingCallScreen has both a real Answer and Decline action",
  incomingScreen.includes("onAnswer") && incomingScreen.includes("onDecline"),
);

// ── The push notification itself stops being a generic, easy-to-miss message ──
ok(
  "a voice_call push gets its own real title, not the generic fallback",
  /type === "voice_call"[\s\S]{0,40}"📞 Incoming call"/.test(notifications),
);
ok(
  "a voice_call push asks to stay on screen / vibrate / re-alert on retry",
  /requireInteraction:\s*true/.test(notifications) &&
    /renotify:\s*true/.test(notifications) &&
    /vibrate:\s*\[/.test(notifications),
);
ok(
  "those extras are scoped to voice_call, not applied to every notification type",
  /type === "voice_call"\s*\n\s*\? \{ requireInteraction: true, renotify: true, vibrate:/.test(notifications),
  "a chat message or announcement must not start requiring interaction just because this changed",
);

// ── The service worker actually honours what the server now sends ──────────
for (const field of ["requireInteraction", "renotify", "vibrate"]) {
  ok(`sw.js reads payload.${field}`, sw.includes(`payload.${field}`));
}

console.log(`test-incoming-call-screen: all ${passed} assertions passed`);
