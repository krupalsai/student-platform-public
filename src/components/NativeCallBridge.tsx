"use client";

import { useEffect } from "react";

/**
 * Bridges IncomingCallActivity's native Answer/Decline buttons (Kotlin,
 * android/app/src/main/java/.../IncomingCallActivity.kt) into this already-
 * running web app, via MainActivity.java's triggerWindowJSEvent.
 *
 * Capacitor's native bridge splices the event's data directly onto the
 * dispatched Event object (see Bridge.java's createEvent — NOT a CustomEvent
 * with `.detail`), so `action`/`callId` are read straight off `event`.
 *
 * Decline is handled directly here — no WebRTC state involved, so a plain
 * fetch using the session token already in localStorage is the whole job
 * (matches loadParticipantCall's isStudentCallback branch server-side).
 *
 * Answer is deliberately NOT auto-joined from here. Actually joining a
 * call's audio needs useVoiceCall's full mic-permission + RTCPeerConnection
 * setup (StudentCallButton, already mounted on the dashboard) — duplicating
 * that state machine here would risk two different code paths racing to
 * accept the same call. Instead this brings the app to the dashboard, where
 * the EXISTING polling (useVoiceCall's tick()) picks up the same still-
 * ringing call within ~1.5s and shows the real IncomingCallScreen — one
 * extra tap, through the one real, already-tested accept path rather than a
 * second parallel one. Revisit once a real device exists to test whether a
 * single-tap answer is worth the added complexity.
 *
 * No-ops entirely outside the Capacitor shell, so this can never affect a
 * student using the existing web app/PWA.
 */
export default function NativeCallBridge() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
    if (!w.Capacitor?.isNativePlatform?.()) return;

    function onNativeCallAction(event: Event) {
      const e = event as unknown as { action?: string; callId?: string };
      if (!e.callId) return;

      if (e.action === "decline_call") {
        const token = localStorage.getItem("sp_token");
        if (!token) return;
        fetch(`/api/calls/${e.callId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "decline" }),
        }).catch(() => {});
        return;
      }

      if (e.action === "answer_call" && !window.location.pathname.startsWith("/dashboard")) {
        window.location.href = "/dashboard";
      }
    }

    window.addEventListener("nativeCallAction", onNativeCallAction);
    return () => window.removeEventListener("nativeCallAction", onNativeCallAction);
  }, []);

  return null;
}
