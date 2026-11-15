"use client";

import { useEffect, useState } from "react";
import { Volume2 } from "lucide-react";
import { ui } from "@/lib/student-ui";
import { installAudioUnlock, playChime, setSoundEnabled, soundEnabled } from "@/lib/notification-sound";

/**
 * Profile → "Notification sounds": the on/off switch for the in-app sound
 * (a soft pop for a new message or reply while the app is open), plus a test
 * button that also raises one real notification so the phone's own alert
 * sound can be checked in the same tap.
 *
 * Alerts while the app is CLOSED are the phone's notification settings, not
 * this switch — the footnote says so.
 */
export default function SoundSettingsCard() {
  const [on, setOn] = useState(true);
  const [note, setNote] = useState("");

  useEffect(() => {
    setOn(soundEnabled());
    installAudioUnlock();
  }, []);

  function toggle() {
    const next = !on;
    setOn(next);
    setSoundEnabled(next);
    setNote("");
    // Hear it straight away; the tap also wakes the browser's audio engine.
    if (next) playChime({ test: true });
  }

  async function test() {
    setNote("");
    playChime({ test: true });
    try {
      if (typeof Notification === "undefined" || !("serviceWorker" in navigator)) return;
      if (Notification.permission === "denied") {
        setNote("Notifications are blocked for this app. Turn them on in your phone's settings.");
        return;
      }
      if (Notification.permission !== "granted") return;
      const reg = await navigator.serviceWorker.ready;
      // Same options a pushed notification gets (public/sw.js), so this tests the real thing.
      await reg.showNotification("Test notification", {
        body: "If you heard a sound, alerts will sound like this when the app is closed.",
        tag: "student-platform-test",
        renotify: true,
        silent: false,
        vibrate: [200, 100, 200],
        icon: "/pwa-icon.svg",
        badge: "/pwa-icon.svg",
        data: { url: "/profile" },
      } as NotificationOptions);
      setNote("Test sent. No sound? Check this app's notification sound in your phone's settings.");
    } catch {
      /* no notification support here — the in-app sound above was the test */
    }
  }

  return (
    <div style={{ background: ui.surface, borderRadius: ui.radius.card, padding: "14px 16px",
      border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span aria-hidden style={{ width: 30, height: 30, borderRadius: 8, background: ui.accent,
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Volume2 size={16} strokeWidth={2} color="#fff" />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p id="sound-switch-label" style={{ fontSize: 14, fontWeight: 500, color: ui.textPrimary, margin: 0 }}>Notification sounds</p>
          <p style={{ fontSize: 11, color: ui.textTertiary, margin: "2px 0 0" }}>New messages and replies while the app is open</p>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-labelledby="sound-switch-label" onClick={toggle}
          style={{ width: 51, height: 31, borderRadius: 999, border: "none", padding: 2, cursor: "pointer", flexShrink: 0,
            background: on ? ui.success : ui.textTertiary, display: "flex", alignItems: "center",
            justifyContent: on ? "flex-end" : "flex-start", transition: "background .15s ease" }}>
          <span aria-hidden style={{ width: 27, height: 27, borderRadius: 999, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
        </button>
      </div>
      {on && (
        <button type="button" onClick={test}
          style={{ marginTop: 10, background: "none", border: "none", padding: "6px 0", cursor: "pointer",
            fontSize: 13, fontWeight: 500, color: ui.accent }}>
          Play a test
        </button>
      )}
      {note && <p role="status" style={{ fontSize: 12, color: ui.textSecondary, margin: "4px 0 0" }}>{note}</p>}
      <p style={{ fontSize: 11, color: ui.textTertiary, margin: "8px 0 0" }}>
        Alerts when the app is closed follow your phone&apos;s notification settings.
      </p>
    </div>
  );
}
