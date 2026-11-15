const API_BASE = "https://api.razorpay.com/v1";

type RazorpayConfig = { keyId: string; keySecret: string };

function getConfig(): RazorpayConfig {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error("Razorpay environment variables are not configured");
  return { keyId, keySecret };
}

function authHeader({ keyId, keySecret }: RazorpayConfig) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

async function request<T>(path: string, init: RequestInit = {}) {
  const config = getConfig();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: authHeader(config), ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error?.description ?? `Razorpay API returned ${response.status}`) as Error & { statusCode?: number };
    error.statusCode = response.status;
    throw error;
  }
  return data as T;
}

export function createRazorpayOrder(input: { amount: number; currency: string; receipt: string; notes?: Record<string, string> }) {
  return request<{ id: string; amount: number; currency: string; status: string }>("/orders", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchRazorpayPayment(paymentId: string) {
  return request<{ id: string; order_id: string; amount: number; currency: string; status: string; captured: boolean; acquirer_data?: { rrn?: string; bank_transaction_id?: string } }>(`/payments/${encodeURIComponent(paymentId)}`);
}

export function fetchRazorpayOrderPayments(orderId: string) {
  return request<{
    entity: "collection";
    count: number;
    items: Array<{
      id: string;
      order_id: string;
      amount: number;
      currency: string;
      status: string;
      captured: boolean;
      acquirer_data?: { rrn?: string; bank_transaction_id?: string };
    }>;
  }>(`/orders/${encodeURIComponent(orderId)}/payments`);
}

// ── Signature verification ──────────────────────────────────────────────
// Two distinct HMACs, two distinct secrets — never conflate them:
//   - Checkout callback (browser → our server, right after Checkout.js closes):
//     HMAC-SHA256("order_id|payment_id", key_secret)
//   - Webhook (Razorpay's servers → our server, async, may arrive before or
//     after the callback, or not at all if the browser closed early):
//     HMAC-SHA256(raw_body, webhook_secret) — a separate secret configured
//     in the Razorpay dashboard, not the API key secret.
import crypto from "crypto";

export function verifyRazorpayPaymentSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
  const { keySecret } = getConfig();
  const expected = crypto.createHmac("sha256", keySecret).update(`${input.orderId}|${input.paymentId}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature));
  } catch {
    return false; // length mismatch etc. — never throw on attacker-controlled input
  }
}

export function verifyRazorpayWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
