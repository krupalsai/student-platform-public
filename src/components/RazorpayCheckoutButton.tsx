"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toPrefillContact } from "@/lib/whatsapp/phone";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, any>) => {
      open: () => void;
      close: () => void;
      on: (event: string, handler: (response: any) => void) => void;
    };
  }
}

async function loadRazorpayCheckout() {
  if (window.Razorpay) return window.Razorpay;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Razorpay Checkout failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Checkout failed to load"));
    document.body.appendChild(script);
  });
  if (!window.Razorpay) throw new Error("Razorpay Checkout is unavailable");
  return window.Razorpay;
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

export default function RazorpayCheckoutButton({
  amountRupees,
  batchSlug,
  name,
  phone,
  createUrl = "/api/create-order",
  verifyUrl = "/api/verify-payment",
  description = "Student registration fee",
  onPaid,
  onGatewayChanged,
}: {
  amountRupees?: number;
  /** Slug of the batch shown on the /pay page. The order must be created
   * for THIS batch — its set fee is the amount charged — never silently
   * for whatever batch the profile happens to be linked to (the two
   * differ in the admin preview and on a stale /pay link). /api/create-order
   * already resolves batch_slug the same way; when omitted the body stays
   * {} and the route falls back to the profile's batch as before. */
  batchSlug?: string;
  name?: string;
  phone?: string;
  /** Overrides for the batch's separate second payment (/api/extra-fee/*). */
  createUrl?: string;
  verifyUrl?: string;
  description?: string;
  onPaid?: () => void;
  /** Called when the create-order call answers 409 GATEWAY_CHANGED (admin
   * flipped the live gateway while this page was open): the /pay page swaps
   * to the live gateway automatically, no student refresh needed. */
  onGatewayChanged?: (gw: "razorpay" | "cashfree" | "phonepe") => void;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function startPayment() {
    if (loading) return;
    setLoading(true);
    setError("");
    setMessage("");

    try {
      const Razorpay = await loadRazorpayCheckout();
      const response = await fetch(createUrl, {
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
        logPaymentEvent("razorpay_order_failed", { status: response.status, error: data?.error ?? "unknown" });
        throw new Error(data?.error ?? "Unable to create payment order.");
      }

      const key = String(data.key_id ?? "").trim();
      const orderId = String(data.order_id ?? "").trim();
      const amount = Number(data.amount);
      const currency = String(data.currency ?? "INR").trim();
      if (!key) throw new Error("Razorpay public key is not configured.");
      if (!orderId) throw new Error("Razorpay order was not created correctly.");
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid Razorpay payment amount.");

      logPaymentEvent("razorpay_checkout_open", {
        order_id: orderId,
        amount,
        currency,
        key_mode: key.startsWith("rzp_live_") ? "live" : key.startsWith("rzp_test_") ? "test" : "unknown",
      });

      // The student's registered phone must be pre-filled so Razorpay never
      // shows an empty number field — a typed-in different number causes
      // confusion and duplicate records. If the prop is empty (profile fetch
      // was slow/failed), fetch it fresh; refuse to open checkout without it
      // rather than show a blank field.
      let contactPhone = phone;
      if (!contactPhone) {
        try {
          const pr = await fetch("/api/profile", { headers: authHeaders(), cache: "no-store" }).then(r => r.json());
          contactPhone = pr?.data?.phone;
        } catch { /* fall through to the check below */ }
      }
      // toPrefillContact() only strips a 91 prefix when the digits actually
      // carry a country code — the old `.replace(/^91/, "")` mangled valid
      // 10-digit numbers starting with 91 (e.g. "9112345678" → "12345678"),
      // which failed the check below and wrongly blocked payment.
      const prefillContact = toPrefillContact(contactPhone);
      if (!prefillContact) {
        throw new Error("We couldn't load your registered mobile number. Please complete your profile and try again.");
      }
      const checkout = new Razorpay({
        key,
        amount,
        currency,
        name: "Student Platform Grey",
        description,
        order_id: orderId,
        prefill: { ...(name ? { name: String(name).slice(0, 100) } : {}), contact: prefillContact },
        notes: { source: "student-platform" },
        theme: { color: "#111827" },
        modal: {
          ondismiss: () => {
            setLoading(false);
            setMessage("Payment cancelled. You can try again.");
          },
        },
        handler: async (paymentResponse: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          logPaymentEvent("razorpay_checkout_success_callback", {
            order_id: paymentResponse.razorpay_order_id,
            payment_id: paymentResponse.razorpay_payment_id,
          });
          try {
            const verifyResponse = await fetch(verifyUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders() },
              body: JSON.stringify(paymentResponse),
            });
            const verified = await verifyResponse.json().catch(() => null);

            if (!verifyResponse.ok || !verified?.success || !verified?.verified) {
              throw new Error(verified?.error ?? "Payment verification failed.");
            }

            if (verified.approved) {
              if (onPaid) { setLoading(false); onPaid(); return; }
              router.replace("/dashboard");
              return;
            }

            setLoading(false);
            setMessage(verified.message ?? "Payment verified. Waiting for payment capture.");
          } catch (e: any) {
            setLoading(false);
            setError(e?.message ?? "Payment verification failed. Please contact support.");
          }
        },
      });

      checkout.on("payment.failed", (response: any) => {
        setLoading(false);
        const failure = response?.error ?? {};
        const code = failure?.code;
        const description = failure?.description || failure?.reason || "Payment failed.";
        logPaymentEvent("razorpay_payment_failed", {
          code: code ?? null,
          description: String(description).slice(0, 500),
          reason: failure?.reason ?? null,
          source: failure?.source ?? null,
          step: failure?.step ?? null,
          order_id: failure?.metadata?.order_id ?? orderId,
          payment_id: failure?.metadata?.payment_id ?? null,
        });
        setError(code ? `${description} (${code})` : String(description));
      });

      checkout.open();
    } catch (e: any) {
      setLoading(false);
      logPaymentEvent("razorpay_checkout_error", { error: e?.message ?? "unknown" });
      setError(e?.message ?? "Unable to start Razorpay checkout.");
    }
  }

  return (
    <div className="w-full">
      {error && <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {message && <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{message}</div>}
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
