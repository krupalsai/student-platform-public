"use client";

import { useEffect } from "react";

/**
 * Registers this device for real native push (Android FCM via
 * @capacitor/push-notifications) — a browser tab cannot receive a
 * high-priority, wake-the-device data push at all, which is the whole reason
 * a native shell exists. Requests the
 * runtime notification permission (Android 13+) and forwards the resulting
 * FCM token to POST /api/push/register-native.
 *
 * No-ops entirely outside the Capacitor shell (window.Capacitor is
 * undefined/isNativePlatform() is false in every ordinary browser/PWA
 * context) and without a logged-in student, so this can never affect
 * anyone using the existing web app.
 */
export default function NativePushRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
    if (!w.Capacitor?.isNativePlatform?.()) return;
    // The Android build only has Firebase when google-services.json was added
    // (TODO #31). Without it, PushNotifications.register() throws a NATIVE
    // "FirebaseApp is not initialized" exception that kills the whole app on
    // launch — no JS error, nothing reported. Stay off until the owner sets
    // NEXT_PUBLIC_NATIVE_PUSH_ENABLED=true after adding the Firebase file.
    if (process.env.NEXT_PUBLIC_NATIVE_PUSH_ENABLED !== "true") return;

    const token = localStorage.getItem("sp_token");
    if (!token) return;

    let cancelled = false;
    let listeners: Array<{ remove: () => void }> = [];

    (async () => {
      try {
        const { PushNotifications } = await import("@capacitor/push-notifications");
        const perm = await PushNotifications.requestPermissions();
        if (cancelled || perm.receive !== "granted") return;

        const regListener = await PushNotifications.addListener("registration", (tokenResult) => {
          fetch("/api/push/register-native", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ token: tokenResult.value, platform: "android" }),
          }).catch(() => {});
        });
        const errListener = await PushNotifications.addListener("registrationError", (err) => {
          console.error("[NativePushRegistrar] registration failed", err);
        });
        listeners = [regListener, errListener];

        await PushNotifications.register();
      } catch (e) {
        console.error("[NativePushRegistrar] setup failed", (e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      listeners.forEach((l) => l.remove());
    };
  }, []);

  return null;
}
