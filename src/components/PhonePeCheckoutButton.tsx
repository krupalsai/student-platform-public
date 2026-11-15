"use client";

import { useState } from "react";

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
 * PhonePe's V2 Checkout API returns one hosted-page URL — no SDK, no modal.
 * A plain full-page redirect is the correct integration for this API (the
 * same one PhonePe's own docs show); confirmation happens the same way as
 * the other two gateways, via /pay/status/[merchantTxnId]?gw=phonepe once
 * the student returns.
 */
export default function PhonePeCheckoutButton({ amountRupees, batchSlug, onGatewayChanged }: {
  amountRupees?: number;
  /** Slug of the batch shown on the /pay page — the order must be created
   * for THIS batch (its set fee is the amount charged), never silently for
   * the profile's batch. See RazorpayCheckoutButton's comment. */
  batchSlug?: string;
  /** Called when /api/phonepe/initiate answers 409 GATEWAY_CHANGED (admin
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
      const response = await fetch("/api/phonepe/initiate", {
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
        logPaymentEvent("phonepe_order_failed", { status: response.status, error: data?.error ?? "unknown" });
        throw new Error(data?.error ?? "Unable to create payment order.");
      }

      const checkoutUrl = String(data.data?.checkout_url ?? "").trim();
      if (!checkoutUrl) throw new Error("Payment checkout link was not created correctly.");

      logPaymentEvent("phonepe_checkout_open", { merchant_txn_id: data.data?.merchant_txn_id });
      window.location.href = checkoutUrl;
    } catch (e: any) {
      setLoading(false);
      logPaymentEvent("phonepe_checkout_error", { error: e?.message ?? "unknown" });
      setError(e?.message ?? "Unable to start PhonePe checkout.");
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
