import { SupabaseClient } from "@supabase/supabase-js";
import { createSign } from "node:crypto";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) return null;
    return parsed as ServiceAccount;
  } catch {
    return null;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Minimal OAuth2 service-account exchange (RS256-signed JWT bearer grant) —
 * deliberately hand-rolled instead of adding the firebase-admin SDK. That
 * package pulls in a large dependency tree for exactly one call this app
 * needs (send); this app already has everything required (node:crypto,
 * fetch) with zero new dependencies, matching the lean-dependency style used
 * everywhere else in this codebase (e.g. the Cashfree/Razorpay webhook HMAC
 * checks are hand-rolled the same way, not pulled from an SDK).
 */
async function getAccessToken(sa: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iss: sa.client_email, scope: FCM_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(sa.private_key));
  const jwt = `${unsigned}.${signature}`;

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
    });
    if (!res.ok) {
      console.error("[native-fcm] token exchange failed", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json();
    if (!data.access_token) return null;
    cachedToken = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) };
    return data.access_token;
  } catch (e) {
    console.error("[native-fcm] token exchange threw", (e as Error).message);
    return null;
  }
}

/**
 * Rings a student's native Android app via a real, OS-level FCM push — the
 * one thing a browser tab genuinely cannot do. This complements rather than
 * replaces the other channels: push +
 * WhatsApp still fire too, this is a third parallel channel, only actually
 * reachable once a Capacitor app build exists on the student's device).
 *
 * MUST be data-only (no `notification` key) — IncomingCallMessagingService's
 * onMessageReceived only runs for data-only messages when the app is
 * backgrounded/killed; a `notification` payload is handled by the OS directly
 * and never reaches our full-screen-intent code at all.
 *
 * Fails open like every other optional external integration in this repo
 * (Gemini/Groq vision, Bank SMS, etc.) — no FIREBASE_SERVICE_ACCOUNT_JSON set,
 * or no native token registered for this student (the common case until the
 * app is actually distributed) both silently no-op rather than error.
 */
export async function sendNativeCallPush(
  db: SupabaseClient,
  studentId: string,
  callId: string,
  callerName: string,
  reason?: string | null
): Promise<void> {
  const sa = loadServiceAccount();
  if (!sa) return;

  const { data: tokens } = await db.from("native_push_tokens").select("id, fcm_token").eq("student_id", studentId);
  if (!tokens?.length) return;

  const accessToken = await getAccessToken(sa);
  if (!accessToken) return;

  await Promise.allSettled(
    tokens.map(async (row) => {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              token: row.fcm_token,
              android: { priority: "high" },
              data: {
                type: "incoming_call",
                callId,
                callerName,
                ...(reason ? { reason } : {}),
              },
            },
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          // UNREGISTERED/404 = uninstalled or the token rotated away. Drop it
          // so future calls stop spending a send attempt on a dead token.
          if (res.status === 404 || text.includes("UNREGISTERED")) {
            await db.from("native_push_tokens").delete().eq("id", row.id);
          } else {
            console.error("[native-fcm] send failed", res.status, text);
          }
        }
      } catch (e) {
        console.error("[native-fcm] send threw", (e as Error).message);
      }
    })
  );
}
