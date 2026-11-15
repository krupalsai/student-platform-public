"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import RazorpayCheckoutButton from "@/components/RazorpayCheckoutButton";
import CashfreeCheckoutButton from "@/components/CashfreeCheckoutButton";
import PhonePeCheckoutButton from "@/components/PhonePeCheckoutButton";

type Gateway = "razorpay" | "cashfree" | "phonepe";

export default function PayPage() {
  const { slug } = useParams() as { slug: string };
  const router = useRouter();
  const [batch, setBatch] = useState<{ name?: string; fee_amount: number; status?: string } | null>(null);
  const [profile, setProfile] = useState<{ full_name?: string; phone?: string } | null>(null);
  // Dual-gateway (owner order 5-Nov-2026): show one pay button per ENABLED
  // gateway instead of a single active gateway, so the student can pick.
  // Cashfree's hosted checkout shows QR only from the PWA, while Razorpay's
  // in-page checkout offers UPI apps — the student picks whichever is easier.
  // Each button still creates its order for THIS batch's set fee only, and
  // each initiate route enforces its own enabled flag, so a disabled gateway
  // can never take a payment even if its button is stale on screen.
  const [enabledGateways, setEnabledGateways] = useState<Gateway[]>([]);
  const [extraFee, setExtraFee] = useState<{ applies?: boolean; amount?: number | null; label?: string; note?: string; status?: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Re-usable: which gateways are currently switched on (admin Settings).
  // Called on mount AND whenever the page regains focus, so a gateway flip
  // while the page is open swaps automatically (owner order 31-Oct-2026) —
  // the student never has to close/reopen the app.
  // Bounded (14 Nov 2026): this fetch joins the pay page's initial load, so
  // a stalled /api/settings must not hold the page on its loading skeleton
  // forever — 12s, then keep the current gateways.
  const refreshGateway = async () => {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch("/api/settings", { cache: "no-store", signal: ctrl.signal }).then(r => r.json());
      if (r?.success) {
        const d = (r.data ?? {}) as Record<string, unknown>;
        const enabled: Gateway[] = [];
        if (d.cashfree_enabled === "true") enabled.push("cashfree");
        if (d.razorpay_enabled === "true") enabled.push("razorpay");
        if (d.phonepe_enabled === "true") enabled.push("phonepe");
        setEnabledGateways((prev: Gateway[]) => (prev.length === enabled.length && prev.every((g: Gateway, i: number) => g === enabled[i]) ? prev : enabled));
      }
    } catch { /* keep the current gateways on transient failure */ } finally {
      window.clearTimeout(t);
    }
  };

  // Called by a checkout button when its initiate call comes back 409
  // GATEWAY_CHANGED (that gateway was switched off while the page was open):
  // re-read settings so the dead button disappears, no refresh needed.
  const handleGatewayChanged = (_g: Gateway) => { void refreshGateway(); };

  useEffect(() => {
    const urlToken = new URLSearchParams(window.location.search).get("t");
    if (urlToken) localStorage.setItem("sp_token", urlToken);
    const token = localStorage.getItem("sp_token");
    if (!token) {
      router.replace("/register");
      return;
    }
    const headers = { Authorization: `Bearer ${token}` };
    // The load calls must never hang the pay page forever (14 Nov 2026: a
    // stalled request left the student on a pulsing box with no error and no
    // way forward). 12s, then the catch below shows "try again" + Go back.
    const loadCtrl = new AbortController();
    const loadTimer = window.setTimeout(() => loadCtrl.abort(), 12000);
    Promise.all([
      fetch(`/api/batches/by-slug/${encodeURIComponent(slug)}`, { cache: "no-store", signal: loadCtrl.signal }).then(r => r.json()),
      fetch("/api/profile", { headers, cache: "no-store", signal: loadCtrl.signal }).then(r => r.json()),
      // Which gateways are currently switched on (admin Settings) — never
      // hardcode a gateway here. See getActivePaymentGateway()'s own comment
      // for why /pay/[slug] must always defer to this, not decide on its own.
      refreshGateway(),
      // Second-payment (UPI-MDR split) state — drives the breakdown below automatically.
      fetch("/api/extra-fee", { headers, cache: "no-store", signal: loadCtrl.signal }).then(r => r.json()).catch(() => null),
    ]).then(([batchResponse, profileResponse, , extraFeeResponse]) => {
      if (!batchResponse?.success || !batchResponse?.data) {
        setError("Could not load the batch payment details.");
        return;
      }
      setBatch({
        name: batchResponse.data.name,
        fee_amount: Number(batchResponse.data.fee_amount) || 0,
        status: batchResponse.data.status,
      });
      if (profileResponse?.success && profileResponse.data) {
        setProfile({ full_name: profileResponse.data.full_name, phone: profileResponse.data.phone });
      }
      // (enabled gateways are set by refreshGateway() in the same Promise.all)
      if (extraFeeResponse?.success && extraFeeResponse.data) {
        setExtraFee(extraFeeResponse.data);
      }
    }).catch(() => setError("Could not load payment details. Please try again."))
      .finally(() => { window.clearTimeout(loadTimer); setLoading(false); });
  }, [slug, router]);

  // If the admin flips a gateway while this page is open (or the student
  // returns to it later), pick up the new gateway automatically.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refreshGateway(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  if (loading) return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader title="Fee Payment" subtitle="Secure & instant" backHref="/dashboard" />
      <main className="mx-4 mt-5"><div className="h-40 rounded-2xl bg-white animate-pulse" /></main>
    </div>
  );

  if (error || !batch) return (
    <main className="min-h-screen bg-white p-6 flex flex-col items-center justify-center text-center">
      <p className="text-sm text-red-600">{error || "Payment details unavailable."}</p>
      <button onClick={() => router.back()} className="mt-5 rounded-xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white">Go back</button>
    </main>
  );

  const amount = Number(batch.fee_amount) || 0;
  // Full fee = batch fee + second installment (from /api/extra-fee, which reports
  // the configured amount even when the split isn't live). Right now UPI costs
  // nothing, so students pay the single total; when the government UPI charge
  // starts, the split below opens automatically into two separate payments.
  const extraAmount = Number(extraFee?.amount) || 0;
  const total = amount + extraAmount;
  const splitApplies = !!extraFee?.applies && extraAmount > 0;
  const payNowAmount = splitApplies ? amount : total;
  const isActive = (batch.status ?? "active") === "active";

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      <PageHeader title="Fee Payment" subtitle="Secure & instant" backHref="/dashboard" />
      <main className="mx-4 mt-5">
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Amount payable</p>
          {splitApplies ? (
            <>
              <div className="mt-3 space-y-2 text-sm text-gray-900">
                <div className="flex items-center justify-between">
                  <span>Payment 1 of 2 — batch fee</span>
                  <span className="font-semibold">₹{amount.toLocaleString("en-IN")}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Payment 2 of 2 — {extraFee.label || "Second payment"}</span>
                  <span className="font-semibold">₹{Number(extraFee.amount).toLocaleString("en-IN")}</span>
                </div>
                <div className="flex items-center justify-between border-t border-gray-200 pt-2 text-base font-bold">
                  <span>Total</span>
                  <span>₹{total.toLocaleString("en-IN")}</span>
                </div>
              </div>
              {extraFee.note && (
                <p className="mt-3 text-xs leading-relaxed text-gray-500">{extraFee.note}</p>
              )}
            </>
          ) : (
            <p className="mt-1 text-4xl font-bold text-gray-900">₹{total.toLocaleString("en-IN")}</p>
          )}
          {batch.name && <p className="mt-2 text-sm text-gray-500">{batch.name}</p>}
        </section>

        {!isActive ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">This batch is not currently accepting payments.</div>
        ) : total <= 0 ? (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Payment amount is not configured. Contact your admin.</div>
        ) : enabledGateways.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">Payments are temporarily unavailable. Please try again shortly, or contact your admin.</div>
        ) : (
          <section className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-gray-900">Choose how to pay</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">Same fee either way — pick whichever is easier for you.</p>
            {enabledGateways.includes("cashfree") && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Pay with UPI QR, card or netbanking</p>
                <CashfreeCheckoutButton amountRupees={payNowAmount} batchSlug={slug} onGatewayChanged={handleGatewayChanged} />
              </div>
            )}
            {enabledGateways.includes("razorpay") && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Pay with UPI app (GPay, PhonePe, Paytm)</p>
                <RazorpayCheckoutButton amountRupees={payNowAmount} batchSlug={slug} name={profile?.full_name} phone={profile?.phone} onGatewayChanged={handleGatewayChanged} />
              </div>
            )}
            {enabledGateways.includes("phonepe") && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Pay with PhonePe</p>
                <PhonePeCheckoutButton amountRupees={payNowAmount} batchSlug={slug} onGatewayChanged={handleGatewayChanged} />
              </div>
            )}
            <p className="mt-4 text-center text-xs leading-relaxed text-gray-500">You&apos;ll be taken to a secure checkout. Your payment is confirmed only after server-side verification.</p>
          </section>
        )}
      </main>
    </div>
  );
}
