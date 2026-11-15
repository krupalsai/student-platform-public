"use client";

/**
 * Shared browser Web Push subscribe logic — pulled out of EnablePushButton
 * so the new full-screen NotificationGate (shown once to every student) can
 * run the exact same real permission-request + subscribe path instead of a
 * second, drifting copy of it.
 */

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64Safe);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Waits for the service worker to be ready, but never forever.
 *
 * `navigator.serviceWorker.ready` only resolves once a worker is active.
 * On a phone mid-update (old worker being replaced), on a fresh install
 * that has not registered one yet, or on a flaky connection, it can hang
 * indefinitely — and both callers below await it while the UI shows
 * "Sending…" / "Turning on…", which reads as a frozen / crashed app.
 * Live-reported exactly that on the registration "Confirm it's you" step.
 * 5s is enough for a slow phone to finish activating; after that the
 * caller falls back (WhatsApp OTP / WhatsApp notifications) instead of
 * hanging. Same idea as the 2s race getThisDeviceEndpoint already uses.
 */
async function awaitServiceWorkerReady(timeoutMs = 5000): Promise<ServiceWorkerRegistration | null> {
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

export async function getVapidPublicKey(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("/api/push/vapid-public-key", { cache: "no-store", signal: controller.signal });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.success !== true || typeof result?.data?.publicKey !== "string") {
      throw new Error("Push notifications are not configured on the server.");
    }
    return result.data.publicKey;
  } catch (e) {
    // A stalled fetch must never leave a button stuck on "Enabling…".
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Push setup timed out. Check your connection and try again.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncPushSubscription(sub: PushSubscription): Promise<void> {
  // The session is proven by the SERVER, not by localStorage. The console
  // authenticates via the sp_session cookie, so a signed-in user can hold
  // a valid cookie while localStorage has no sp_token — after the
  // gray→canonical handoff, a direct visit, or cleared storage. The old
  // guard threw "session expired" here without ever asking the server, so
  // the notifications card showed expired on a signed-in console (live
  // 9 Nov 2026). The server's requireSession() accepts the cookie, so the
  // Bearer token is sent only when one exists and a 401 is what decides
  // the session is really gone. Same-origin fetch sends the cookie.
  const token = window.localStorage.getItem("sp_token") ?? "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("/api/push/subscribe", {
      method: "POST",
      headers,
      body: JSON.stringify(sub.toJSON()),
      signal: controller.signal,
      credentials: "same-origin",
    });
    const result = await response.json().catch(() => null);
    if (response.status === 401) {
      throw new Error("Your session has expired. Please sign in again.");
    }
    if (!response.ok || result?.success !== true) {
      throw new Error(result?.error ?? `Subscription save failed (${response.status}).`);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Saving notification access timed out. Check your connection and try again.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Requests the browser permission (must be called from a real user gesture)
 * then subscribes + saves. Throws on any failure; caller decides the UX.
 *
 * Every step that can stall is bounded — a previous version awaited the
 * permission prompt, getSubscription() and subscribe() with no timeout at
 * all, so a slow phone left the caller stuck on "Enabling…" forever (live
 * 9 Nov 2026: the admin console's Enable button never resolved on an
 * expired session). The whole call is also capped end-to-end (25s) so no
 * combination of slow steps can stick the button. */
export async function requestAndSubscribeToPush(): Promise<{ granted: boolean }> {
  const inner = (async (): Promise<{ granted: boolean }> => {
    const publicKey = await getVapidPublicKey();
    // The permission prompt needs a real answer, but it must never leave
    // the caller hanging: on a slow phone the prompt can sit unanswered.
    // If it is still unanswered after 15s, treat it as not granted — the
    // user can tap again and, if they granted meanwhile, it resolves at once.
    const permission = await Promise.race([
      Notification.requestPermission(),
      new Promise<NotificationPermission>((resolve) =>
        setTimeout(() => resolve("default"), 15000),
      ),
    ]);
    if (permission !== "granted") return { granted: false };
    const reg = await awaitServiceWorkerReady();
    if (!reg) return { granted: false };
    const existing = await Promise.race([
      reg.pushManager.getSubscription(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    const sub = existing ?? await Promise.race([
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
    ]);
    if (!sub) throw new Error("Turning on notifications timed out. Check your connection and try again.");
    await syncPushSubscription(sub);
    return { granted: true };
  })();
  return await Promise.race([
    inner,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Turning on notifications took too long. Check your connection and try again.")),
        25000,
      ),
    ),
  ]);
}

/** This browser's own push endpoint, or null when notifications are off or
 * unsupported. Never prompts. Sent with a login-code request so the server
 * can deliver the code in-app — it only does so if this endpoint is already
 * linked to that account. */
export async function getThisDeviceEndpoint(): Promise<string | null> {
  try {
    if (!isPushSupported() || Notification.permission !== "granted") return null;
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!reg) return null;
    // getSubscription() has no timeout of its own — race it like the
    // service-worker ready above, so a stalled push manager can never
    // leave the login button stuck on "Sending…".
    const sub = await Promise.race([
      reg.pushManager.getSubscription(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
    ]);
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

/**
 * Replaces this browser's push subscription with a fresh one under the
 * server's CURRENT VAPID key. Only runs when notifications are already
 * granted — it never prompts.
 *
 * Why this exists: a subscription is bound to the applicationServerKey it
 * was created with. When the server's VAPID key rotates (9 Nov 2026: the
 * old private key was never saved, so a new pair was generated), every
 * stored subscription fails with 403 "VAPID credentials do not
 * correspond" — and reusing it, as requestAndSubscribeToPush does, never
 * heals it. The phone must unsubscribe and subscribe again under the new
 * key. The fresh subscription is linked to the account the next time the
 * student is signed in (post-login sync), so the FIRST login after a
 * rotation still goes through WhatsApp once, and every login after that
 * arrives by push.
 *
 * Called from the login screen after a code send falls back to WhatsApp
 * (push proven broken for this phone), in the background — it never
 * blocks the login itself.
 */
export async function refreshPushSubscription(): Promise<PushSubscription | null> {
  try {
    if (!isPushSupported() || Notification.permission !== "granted") return null;
    const publicKey = await getVapidPublicKey();
    const reg = await awaitServiceWorkerReady();
    if (!reg) return null;
    const existing = await Promise.race([
      reg.pushManager.getSubscription(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (existing) {
      try {
        await Promise.race([
          existing.unsubscribe(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
      } catch {
        // Unsubscribe failing must not block creating the fresh one.
      }
    }
    const sub = await Promise.race([
      reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    return sub;
  } catch {
    return null;
  }
}

/**
 * Build a Web Push subscription on THIS device without saving it to the
 * server. Used by screens the user reaches before they have a session
 * (registration phone confirmation, logged-out login): the code still has
 * to reach this exact browser, so the subscription is created locally and
 * handed to the request that sends the OTP. Returns null when push is
 * unsupported (caller shows the unsupported guidance instead), and
 * also when the service worker does not become ready within 5s — the
 * caller then falls back to WhatsApp instead of hanging.
 */
export async function createLocalPushSubscription(): Promise<PushSubscription | null> {
  try {
    if (!isPushSupported()) return null;
    const publicKey = await getVapidPublicKey();
    const reg = await awaitServiceWorkerReady();
    if (!reg) return null;
    const existing = await Promise.race([
      reg.pushManager.getSubscription(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    return existing ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  } catch {
    return null;
  }
}
