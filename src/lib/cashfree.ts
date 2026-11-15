/**
 * Cashfree Payment Gateway — API wrapper (PG API version 2026-01-01)
 */

import crypto from "crypto";

const APP_ID = (process.env.CASHFREE_APP_ID ?? "").trim();
const SECRET_KEY = (process.env.CASHFREE_SECRET_KEY ?? "").trim();
const ENV = (process.env.CASHFREE_ENV ?? "SANDBOX").trim().toUpperCase();
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(/\/$/, "");

const API_BASE = ENV === "PROD" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
const API_VERSION = "2026-01-01";

export const CASHFREE_MODE = ENV === "PROD" ? "production" : "sandbox";

export function isCashfreeConfigured(): boolean {
  return !!(APP_ID && SECRET_KEY);
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-version": API_VERSION,
    "x-client-id": APP_ID,
    "x-client-secret": SECRET_KEY,
  };
}

export interface CashfreeOrderParams {
  orderId: string;
  amount: number;
  studentId: string;
  studentName?: string | null;
  phone?: string | null;
  note?: string;
}

export interface CashfreeOrderResult {
  success: boolean;
  orderId: string;
  paymentSessionId?: string;
  error?: string;
}

/**
 * Creates a universal Cashfree hosted checkout.
 *
 * Payment coverage:
 * - UPI app/Intent when Cashfree and the device/browser support it
 * - Dynamic UPI QR as the universal UPI fallback
 * - Credit/debit cards
 * - Net banking
 *
 * We do not force a device-specific UPI flow because desktop, Android and iOS
 * have different app-launch capabilities. Cashfree handles eligibility while
 * the order keeps every broadly supported payment method available.
 */
export async function createCashfreeOrder(p: CashfreeOrderParams): Promise<CashfreeOrderResult> {
  if (!isCashfreeConfigured()) {
    return { success: false, orderId: p.orderId, error: "Cashfree is not configured." };
  }

  const customerId = p.studentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 50);
  const digits = (p.phone ?? "").replace(/\D/g, "").slice(-10);

  const body = {
    order_id: p.orderId,
    order_amount: Number(p.amount.toFixed(2)),
    order_currency: "INR",
    customer_details: {
      customer_id: customerId,
      customer_name: (p.studentName ?? "Student").slice(0, 100),
      customer_phone: digits.length === 10 ? digits : "9999999999",
      customer_email: "noreply@student-platform.app",
    },
    order_meta: {
      // Keep all major payment methods available on every device.
      // On eligible mobile-web sessions Cashfree can additionally surface its
      // UPI app row according to the 2026 UPI app-priority configuration.
      payment_methods: "upi,cc,dc,nb",
      upi_app_priority: [
        "gpay",
        "phonepe",
        "paytm",
        "navi",
        "cred",
        "supermoney",
        "amazonpay",
        "bhim",
        "mobikwik",
        "airtel",
        "popclub",
        "kiwi",
      ],
      return_url: `${APP_URL}/pay/status/{order_id}`,
      notify_url: `${APP_URL}/api/cashfree/webhook`,
    },
    order_note: (p.note ?? "").slice(0, 200),
  };

  try {
    const res = await fetch(`${API_BASE}/orders`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);

    if (!res.ok || !json?.payment_session_id) {
      const msg = json?.message ?? `Cashfree returned HTTP ${res.status}`;
      console.error("[cashfree] order create failed:", JSON.stringify({ status: res.status, code: json?.code, message: msg }));
      return { success: false, orderId: p.orderId, error: msg };
    }

    return {
      success: true,
      orderId: json.order_id ?? p.orderId,
      paymentSessionId: json.payment_session_id,
    };
  } catch (e) {
    console.error("[cashfree] order create network error:", e);
    return { success: false, orderId: p.orderId, error: "Could not reach the payment gateway." };
  }
}

export interface CashfreeStatusResult {
  success: boolean;
  orderStatus?: string;
  paid: boolean;
  amount?: number;
  cfPaymentId?: string;
  bankReference?: string;
  error?: string;
}

export async function checkCashfreeStatus(orderId: string): Promise<CashfreeStatusResult> {
  if (!isCashfreeConfigured()) {
    return { success: false, paid: false, error: "Cashfree is not configured." };
  }
  try {
    const res = await fetch(`${API_BASE}/orders/${encodeURIComponent(orderId)}`, { headers: headers() });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      return { success: false, paid: false, error: json?.message ?? `HTTP ${res.status}` };
    }

    const orderStatus = String(json.order_status ?? "");
    const result: CashfreeStatusResult = {
      success: true,
      orderStatus,
      paid: orderStatus === "PAID",
      amount: Number(json.order_amount ?? 0),
    };

    if (result.paid) {
      const pRes = await fetch(`${API_BASE}/orders/${encodeURIComponent(orderId)}/payments`, { headers: headers() });
      const payments = await pRes.json().catch(() => null);
      const success = Array.isArray(payments)
        ? payments.find((x: any) => String(x?.payment_status).toUpperCase() === "SUCCESS")
        : null;
      if (success) {
        result.cfPaymentId = String(success.cf_payment_id ?? "");
        result.bankReference = String(success.bank_reference ?? "");
      }
    }
    return result;
  } catch (e) {
    console.error("[cashfree] status check failed:", e);
    return { success: false, paid: false, error: "Could not reach the payment gateway." };
  }
}

export function verifyCashfreeWebhook(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
): boolean {
  if (!SECRET_KEY || !signature || !timestamp) return false;
  try {
    const expected = crypto.createHmac("sha256", SECRET_KEY).update(timestamp + rawBody).digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    console.error("[cashfree] signature verify failed:", e);
    return false;
  }
}

export function genCashfreeOrderId(studentId: string): string {
  const suffix = studentId.replace(/-/g, "").slice(-8).toUpperCase();
  const ts = Date.now().toString(36).toUpperCase().slice(-6);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CF-${suffix}-${ts}-${rand}`;
}
