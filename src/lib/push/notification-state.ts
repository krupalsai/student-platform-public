"use client";

/**
 * Shared notification-capability detection for the OTP screens (login,
 * registration). The OTP arrives as an app push notification, so both
 * screens gate on this before requesting a code.
 *
 * - native: Capacitor shell — push is handled natively, skip the web gate.
 * - granted / denied / prompt: the browser Notification permission state.
 * - unsupported: no Notification/PushManager API — an OTP can never arrive.
 */

export type NotifState = "checking" | "native" | "granted" | "denied" | "prompt" | "unsupported";

export function detectNotifState(): Exclude<NotifState, "checking"> {
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  if (w.Capacitor?.isNativePlatform?.()) return "native";
  if (!("Notification" in window)) return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  const p: NotificationPermission = Notification.permission;
  return p === "granted" ? "granted" : p === "denied" ? "denied" : "prompt";
}
