/**
 * Web push send client — thin wrapper over the `web-push` library. No
 * business logic here; this only knows how to send a payload to a single
 * already-stored subscription, given already-decided content.
 */

import webpush from "web-push";

// Prefer the server-only variable. The NEXT_PUBLIC fallback is retained only
// for migration safety; when it accidentally contains multiple lines, use
// only its first line as the public key and never pass the extra value to
// web-push.
const configuredPublicKey = process.env.VAPID_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const PUBLIC_KEY = configuredPublicKey.split(/\r?\n/, 1)[0].trim();
const PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY ?? "").trim();
const SUBJECT = process.env.VAPID_SUBJECT ?? "https://studentplatform.dev";

let configured = false;

function isConfigured(): boolean {
  return /^[A-Za-z0-9_-]{80,100}$/.test(PUBLIC_KEY) && /^[A-Za-z0-9_-]{40,60}$/.test(PRIVATE_KEY);
}

function ensureConfigured() {
  if (configured || !isConfigured()) return;
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  configured = true;
}

export type StoredPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * A push send must never hang its caller: `web-push` makes its HTTPS
 * request with no timeout of its own, so a stalled push service used to
 * leave the login-code request (which awaits the send) hanging until the
 * client gave up — the 15-second "Sending…" stall of 9 Nov 2026. 10s is
 * the bound (raised from 5s on 9 Nov 2026: a healthy FCM round trip is
 * ~1s, but a slow one past 5s made the server report "didn't arrive" and
 * delete the OTP while FCM still delivered the notification seconds
 * later — the timeout only abandons waiting, it does not cancel the send).
 */
const PUSH_SEND_TIMEOUT_MS = 10000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => { if (timer !== undefined) clearTimeout(timer); }),
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("push send timed out")), ms);
    }),
  ]);
}

/**
 * Why a push send did not go through. Callers MUST record this instead of
 * silently counting the send as delivered — a silent `ok: false` is how
 * half the subscription fleet ended up flagged failed with nobody knowing
 * whether the VAPID key, the subscription, or the push service was at fault.
 *
 * - "not_configured": VAPID keys missing/malformed on the server — nothing
 *   was even attempted. Fix is env vars, not the subscription.
 * - "expired": push service 404/410 — the subscription is dead, delete it.
 * - "unauthorized": push service 401/403 — the VAPID key pair does not match
 *   (wrong/rotated private key). The subscription was created under a
 *   different key pair and can never receive from this server again, so
 *   it is dead too — delete it, do not merely mark it failed.
 * - "push_service_error": any other HTTP status from the push service.
 * - "network_error": no HTTP status at all (DNS / timeout / connection).
 */
export type PushSendResult = {
  ok: boolean;
  expired: boolean;
  // True when the push service will never deliver to this subscription
  // again from this server: 404/410 (endpoint gone) or 401/403 (VAPID
  // mismatch — e.g. after a key rotation). Callers must DELETE the
  // subscription on `dead`: retrying it is pointless, and every retry
  // shows the student another red error first.
  dead: boolean;
  reason?: string;
  statusCode?: number;
};

/** True when the VAPID key pair is present and well-formed. Exposed for the admin push-test route — it reports configuration, never key values. */
export function isPushConfigured(): boolean {
  return isConfigured();
}

/**
 * Sends a push message to one subscription. Returns ok:false (never throws)
 * on any failure — including a 404/410 from the push service, which means
 * the subscription is dead and the caller should delete it, and a 401/403,
 * which means the VAPID key pair no longer matches the one the subscription
 * was created with (e.g. after a key rotation) — also dead, also delete.
 * Callers must treat ok:false as "this channel didn't work", record `reason`,
 * and never report the send as delivered.
 */
export async function sendPushMessage(
  sub: StoredPushSubscription,
  payload: Record<string, unknown>
): Promise<PushSendResult> {
  if (!isConfigured()) return { ok: false, expired: false, dead: false, reason: "not_configured" };
  ensureConfigured();

  try {
    await withTimeout(
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        JSON.stringify(payload)
      ),
      PUSH_SEND_TIMEOUT_MS
    );
    return { ok: true, expired: false, dead: false };
  } catch (e) {
    const statusCode = (e as { statusCode?: number })?.statusCode;
    const expired = statusCode === 404 || statusCode === 410;
    const unauthorized = statusCode === 401 || statusCode === 403;
    const reason = expired
      ? "expired"
      : unauthorized
        ? "unauthorized"
        : typeof statusCode === "number"
          ? "push_service_error"
          : "network_error";
    if (!expired) console.error("[push] send failed", statusCode, reason, e);
    return { ok: false, expired, dead: expired || unauthorized, reason, statusCode };
  }
}
