"use client";

import { useState } from "react";

declare global {
  interface Window {
    Cashfree?: (options: { mode: "sandbox" | "production" }) => {
      checkout: (options: Record<string, unknown>) => Promise<{ error?: { message?: string } }>;
    };
  }
}

async function loadCashfreeSdk(): Promise<NonNullable<Window["Cashfree"]>> {
  if (window.Cashfree) return window.Cashfree;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://sdk.cashfree.com/js/v3/cashfree.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Cashfree Checkout failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://sdk.cashfree.com/js/v3/cashfree.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Cashfree Checkout failed to load"));
    document.body.appendChild(script);
  });
  if (!window.Cashfree) throw new Error("Cashfree Checkout is unavailable");
  return window.Cashfree;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("sp_token") ?? "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function logPaymentEvent(event: string, detail: Record<string, unknown>) {
  fetch("/api/payment-funnel-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, detail }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Same shape and behaviour as RazorpayCheckoutButton, kept as a genuinely
 * separate component (not a variant switch inside one component) because
 * the two SDKs' loading/checkout calls are different enough that sharing
 * would mean an if/else on every line rather than one clean flow each.
 *
 * Cashfree's checkout() with `redirectTarget: "_self"` navigates the CURRENT
 * tab to Cashfree's hosted page — no modal, so there is no in-page success
 * callback. Confirmation happens the same way it already does for the
 * other two gateways: the student lands on Cashfree's own `return_url`
 * (already set to /pay/status/{order_id} in createCashfreeOrder), which
 * polls /api/cashfree/status/[orderId] until the payment is confirmed.
 */
export default function CashfreeCheckoutButton({ amountRupees, batchSlug, onGatewayChanged }: {
  amountRupees?: number;
  /** Slug of the batch shown on the /pay page — the order must be created
   * for THIS batch (its set fee is the amount charged), never silently for
   * the profile's batch. See RazorpayCheckoutButton's comment. */
  batchSlug?: string;
  /** Called when /api/cashfree/initiate answers 409 GATEWAY_CHANGED (admin
   * flipped the live gateway while this page was open): the /pay page swaps
   * to the live gateway automatically, no student refresh needed. */
  onGatewayChanged?: (gw: "razorpay" | "cashfree" | "phonepe") => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startPayment() {
    if (loading) return;
    setLoading(true);
    setError("");

    try {
      const Cashfree = await loadCashfreeSdk();
      const response = await fetch("/api/cashfree/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ batch_slug: batchSlug }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => null);
      // Stale gateway (admin flipped while the page was open): the backend
      // tells us which gateway IS live — hand it to the /pay page so it can
      // swap automatically instead of showing a dead error.
      if (response.status === 409 && data?.code === "GATEWAY_CHANGED" && data?.active_gateway && onGatewayChanged) {
        const g = String(data.active_gateway);
        if (g === "razorpay" || g === "cashfree" || g === "phonepe") {
          setLoading(false);
          onGatewayChanged(g);
          return;
        }
      }
      if (!response.ok || !data?.success) {
        logPaymentEvent("cashfree_order_failed", { status: response.status, error: data?.error ?? "unknown" });
        throw new Error(data?.error ?? "Unable to create payment order.");
      }

      const sessionId = String(data.data?.payment_session_id ?? "").trim();
      const mode = data.data?.mode === "production" ? "production" : "sandbox";
      if (!sessionId) throw new Error("Payment session was not created correctly.");

      logPaymentEvent("cashfree_checkout_open", { order_id: data.data?.order_id, mode });

      const cashfree = Cashfree({ mode });
      const result = await cashfree.checkout({ paymentSessionId: sessionId, redirectTarget: "_self" });
      if (result?.error) {
        logPaymentEvent("cashfree_checkout_error", { error: result.error.message ?? "unknown" });
        setError(result.error.message ?? "Unable to open Cashfree checkout.");
        setLoading(false);
      }
      // On success, redirectTarget:"_self" navigates away — nothing else to do here.
    } catch (e: any) {
      setLoading(false);
      logPaymentEvent("cashfree_checkout_error", { error: e?.message ?? "unknown" });
      setError(e?.message ?? "Unable to start Cashfree checkout.");
    }
  }

  return (
    <div className="w-full">
      {error && <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <button
        type="button"
        onClick={startPayment}
        disabled={loading}
        className="w-full rounded-2xl bg-gray-900 px-4 py-4 text-base font-bold text-white transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Opening secure checkout…" : amountRupees ? `Pay ₹${amountRupees.toLocaleString("en-IN")} securely` : "Pay securely"}
      </button>
    </div>
  );
}
