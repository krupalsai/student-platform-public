/**
 * PhonePe Payment Gateway — SDK wrapper (PG Checkout API v2)
 *
 * Restored (2026-09-27) as one of THREE switchable gateways — Cashfree,
 * Razorpay, PhonePe — after Razorpay's free-tier transaction limit and
 * PhonePe's own free-tier fund-receipt issues made the admin want to be
 * able to flip between whichever one is currently viable, from Settings,
 * with no code change. See `src/lib/services/payment-settings.ts`'s
 * `getActivePaymentGateway()` for the single place that decides which one
 * is live. (This was fully
 * deleted once already — "Cashfree is the sole gateway" —
 * then briefly, silently resurrected by an unreviewed commit and deleted
 * AGAIN in a security audit before the admin asked for it back as a real,
 * intentional, switchable option this time).
 *
 * Uses the current Client ID / Client Secret OAuth model (V2), not the
 * legacy Salt Key ("Hermes") model — this merchant account is provisioned
 * for V2 credentials only; V1 endpoints (/pg/v1/pay, /pg/v1/status) return
 * errors on a V2-only account.
 *
 * Credentials needed (Vercel env vars):
 *   PHONEPE_CLIENT_ID        — PhonePe dashboard → Developer Settings
 *   PHONEPE_CLIENT_SECRET    — PhonePe dashboard → Developer Settings
 *   PHONEPE_CLIENT_VERSION   — usually "1", same dashboard page
 *   PHONEPE_ENV              — "PROD" or "UAT" (default UAT for testing)
 *   NEXT_PUBLIC_APP_URL      — this app's public URL
 *   PHONEPE_WEBHOOK_SECRET   — NEW (security fix 2026-10-26): a secret YOU
 *                              choose, used to HMAC-sign every webhook
 *                              request body. The old PHONEPE_WEBHOOK_USERNAME /
 *                              PHONEPE_WEBHOOK_PASSWORD ("Authentication Type:
 *                              SHA") are RETIRED — that value was the same on
 *                              every call, so anyone who saw it once could
 *                              forge webhooks forever. Set this in Vercel
 *                              before re-enabling PhonePe; until it is set,
 *                              the webhook rejects everything (fail closed).
 *                              PhonePe's V2 dashboard does not send a
 *                              per-request HMAC itself, so before
 *                              re-enabling PhonePe, confirm with PhonePe how
 *                              the signature header is delivered (dashboard
 *                              setting or a signing forwarder) — do not just
 *                              flip the gateway flag back on.
 *
 * PhonePe docs: https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-integration-website
 *
 * Auth model: unlike V1 (stateless per-request checksum), V2 requires
 * fetching a short-lived OAuth bearer token first, then using it on every
 * subsequent call as `Authorization: O-Bearer <token>`. Tokens are cached
 * in-memory for their lifetime to avoid re-authenticating on every request
 * (PhonePe's own guidance: refresh ~5 minutes before expiry).
 */

import crypto from "crypto";
import { buildSafeRedirectUrl } from "./url-safety";

// PhonePe's own integration support team explicitly flagged leading/
// trailing whitespace on copy-pasted credentials as a common, easy-to-miss
// cause of authentication failures (e.g. a trailing newline from copying
// out of a dashboard or password manager). .trim() defends against this
// without masking a genuinely missing/placeholder value.
const CLIENT_ID      = (process.env.PHONEPE_CLIENT_ID      ?? "PLACEHOLDER_CLIENT_ID").trim();
const CLIENT_SECRET  = (process.env.PHONEPE_CLIENT_SECRET  ?? "PLACEHOLDER_CLIENT_SECRET").trim();
const CLIENT_VERSION = (process.env.PHONEPE_CLIENT_VERSION ?? "1").trim();
const ENV            = (process.env.PHONEPE_ENV            ?? "UAT").trim();

const WEBHOOK_SECRET = (process.env.PHONEPE_WEBHOOK_SECRET ?? "").trim();

// V2 uses different hosts for auth vs. payment/status calls, and a
// different auth host for UAT vs. PROD specifically (per PhonePe docs —
// this is not a typo, PROD auth genuinely lives under identity-manager).
const AUTH_URL = ENV === "PROD"
  ? "https://api.phonepe.com/apis/identity-manager/v1/oauth/token"
  : "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token";

const API_BASE = ENV === "PROD"
  ? "https://api.phonepe.com/apis/pg"
  : "https://api-preprod.phonepe.com/apis/pg-sandbox";

/** Whether real (non-placeholder) PhonePe credentials are configured. */
export function isPhonePeConfigured(): boolean {
  return CLIENT_ID !== "PLACEHOLDER_CLIENT_ID" && CLIENT_SECRET !== "PLACEHOLDER_CLIENT_SECRET";
}

export interface PhonePeOrderParams {
  merchantTransactionId: string; // unique per payment attempt, max 38 chars
  amount: number;                // in PAISE (₹2 = 200)
  studentId: string;
  batchSlug: string;
  mobileNumber?: string;
  sessionToken?: string;         // passed through to redirectUrl for iOS Safari auth
}

export interface PhonePeOrderResult {
  success: boolean;
  merchantTransactionId: string;
  redirectUrl?: string;    // UPI intent URL — open in UPI app
  checkoutPageUrl?: string; // PhonePe hosted checkout page
  error?: string;
}

export interface PhonePeStatusResult {
  success: boolean;
  state?: "COMPLETED" | "PENDING" | "FAILED";
  merchantTransactionId?: string;
  transactionId?: string;   // PhonePe's own txn ID
  amount?: number;          // in paise
  paymentInstrument?: {
    type: string;
    utr?: string;
  };
  error?: string;
}

// ── In-memory token cache ────────────────────────────────────────────────
// A fresh Vercel serverless instance has no cache, which is fine — it just
// means the first call after a cold start fetches a new token. Warm
// instances reuse the cached token until ~5 min before its reported expiry.
let cachedToken: { token: string; expiresAtMs: number } | null = null;

async function getAuthToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs - 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_version: CLIENT_VERSION,
    client_secret: CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(15000), // fail loudly after 15s instead of hanging forever
  });

  const rawText = await res.text();
  let json: any;
  try { json = JSON.parse(rawText); } catch { json = {}; }

  if (!res.ok || !json.access_token) {
    throw new Error(`OAUTH_STEP_FAILED status=${res.status} body=${rawText.slice(0, 300)}`);
  }

  // expires_at from PhonePe is in epoch seconds; fall back to a 15-min
  // assumption if it's ever missing so we don't cache forever on a bad response.
  const expiresAtMs = json.expires_at
    ? Number(json.expires_at) * 1000
    : Date.now() + 15 * 60 * 1000;

  cachedToken = { token: json.access_token, expiresAtMs };
  return json.access_token;
}

/**
 * Verify a PhonePe webhook signature — per-request HMAC (security fix
 * 2026-10-26, replaces the old static check).
 *
 * The old check compared the Authorization header against one fixed value,
 * SHA256("username:password"), which was identical on every webhook call —
 * anyone who saw that header once could forge any webhook forever.
 *
 * The new check is HMAC-SHA256(PHONEPE_WEBHOOK_SECRET, raw request body),
 * hex-encoded, compared timing-safe. The signature is read from the
 * `X-PhonePe-Signature` header (falling back to `Authorization`, which is
 * where PhonePe delivers its webhook credential). If the secret is not
 * configured, verification FAILS CLOSED — every webhook is rejected.
 * The header value itself is never logged.
 */
export function verifyPhonePeWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!WEBHOOK_SECRET || !signature) return false;
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature.trim());
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/** Initiate a PhonePe payment order (V2 Checkout API) */
export async function createPhonePeOrder(
  params: PhonePeOrderParams
): Promise<PhonePeOrderResult> {
  // Include a short-lived session token in the redirect URL so the status
  // page can authenticate when loaded in a browser after PhonePe redirects.
  // The token is already the student's session token from our own DB — passing
  // it on our own HTTPS redirect URL is safe (same security as the Authorization
  // header, and the URL is only ever seen by our own server and the student's browser).
  // `gw=phonepe` tells the shared /pay/status page which gateway's status route to poll.
  const tokenParam = params.sessionToken ? `t=${encodeURIComponent(params.sessionToken)}&` : "";
  const redirectUrl = buildSafeRedirectUrl(`/pay/status/${params.merchantTransactionId}?${tokenParam}gw=phonepe`);

  const payload = {
    merchantOrderId: params.merchantTransactionId,
    amount: params.amount, // paise
    expireAfter: 1200, // 20 minutes, matches PhonePe's documented default
    metaInfo: {
      udf1: params.studentId,
      udf2: params.batchSlug,
    },
    paymentFlow: {
      type: "PG_CHECKOUT",
      message: "Student Platform registration fee",
      merchantUrls: { redirectUrl },
    },
  };

  // Fail fast with a clear message if credentials were never actually
  // configured, rather than letting PhonePe's API reject an obviously
  // invalid client_id in some slower/less obvious way.
  if (!isPhonePeConfigured()) {
    return {
      success: false,
      merchantTransactionId: params.merchantTransactionId,
      error: "PhonePe is not configured (missing PHONEPE_CLIENT_ID / PHONEPE_CLIENT_SECRET env vars).",
    };
  }

  try {
    const token = await getAuthToken();

    const res = await fetch(`${API_BASE}/checkout/v2/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `O-Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000), // fail loudly after 20s instead of hanging forever
    });

    const rawText = await res.text();
    let json: any;
    try { json = JSON.parse(rawText); } catch { json = {}; }

    if (!res.ok) {
      return {
        success: false,
        merchantTransactionId: params.merchantTransactionId,
        error: `PAY_STEP_FAILED status=${res.status} body=${rawText.slice(0, 300)}`,
      };
    }

    // V2's create-payment response returns a single hosted checkout
    // "redirectUrl" (not a separate UPI intent link) — the PhonePe-hosted
    // page itself presents UPI/card/netbanking options to the student.
    return {
      success: true,
      merchantTransactionId: params.merchantTransactionId,
      checkoutPageUrl: json.redirectUrl ?? undefined,
    };
  } catch (e: any) {
    return {
      success: false,
      merchantTransactionId: params.merchantTransactionId,
      error: e.message ?? "Network error",
    };
  }
}

/** Check status of a PhonePe transaction (V2 Checkout API) */
export async function checkPhonePeStatus(
  merchantTransactionId: string
): Promise<PhonePeStatusResult> {
  try {
    const token = await getAuthToken();

    const res = await fetch(
      `${API_BASE}/checkout/v2/order/${encodeURIComponent(merchantTransactionId)}/status?details=false`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `O-Bearer ${token}`,
        },
      }
    );

    const json = await res.json();

    if (!res.ok) {
      return { success: false, error: json.message ?? `Status check failed (${res.status})` };
    }

    // V2's order-status response is a flat object (state, amount, paymentDetails[])
    // — no {success, data:{...}} envelope like V1 had.
    const firstPayment = Array.isArray(json.paymentDetails) ? json.paymentDetails[0] : undefined;

    return {
      success: true,
      state: json.state,
      merchantTransactionId,
      transactionId: firstPayment?.transactionId,
      amount: json.amount,
      paymentInstrument: firstPayment
        ? {
            type: firstPayment.paymentMode,
            utr: firstPayment.rail?.upiTransactionId ?? firstPayment.rail?.authorizationCode,
          }
        : undefined,
    };
  } catch (e: any) {
    return { success: false, error: e.message ?? "Network error" };
  }
}
