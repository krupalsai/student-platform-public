"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

// This page redirects to either a UPI deep-link scheme or PhonePe's hosted
// checkout page (V2 Checkout API returns an https:// URL, not a upi://
// intent link). Some mobile browsers block these schemes/navigations when
// triggered directly from a nested web context. Opening this HTTPS page first
// and then redirecting here works around that restriction.
function RedirectInner() {
  const searchParams = useSearchParams();
  const [showFallback, setShowFallback] = useState(false);
  const [copied, setCopied] = useState(false);

  const url = searchParams.get("url");

  // Extract the actual UPI ID from a upi:// link (pa= param) so the
  // fallback instruction has something real to show — previously it told
  // students to "copy the UPI ID" with no ID ever displayed anywhere.
  let upiId: string | null = null;
  if (url?.startsWith("upi://")) {
    try {
      upiId = new URL(url).searchParams.get("pa");
    } catch { /* malformed, upiId stays null */ }
  }
  const isPhonePeCheckout = url?.startsWith("https://") ?? false;

  useEffect(() => {
    if (!url) return;

    const allowedSchemes = ["upi://", "gpay://", "phonepe://", "paytmmp://", "bhim://"];
    let isAllowed = allowedSchemes.some(s => url.startsWith(s));
    if (!isAllowed && url.startsWith("https://")) {
      try {
        const host = new URL(url).hostname;
        // PhonePe's hosted checkout is served from numbered/lettered
        // subdomains that vary per request (e.g. mercury-t2.phonepe.com,
        // mercury-uat.phonepe.com) — a fixed exact-match list missed real
        // checkout URLs and silently blocked the redirect for some
        // students (confirmed via DB: order created successfully, but
        // never progressed past pg_pending — the checkout page never
        // actually opened). Anchored suffix check is safe against a
        // spoofed host like "phonepe.com.evil.com", which does NOT end
        // with ".phonepe.com".
        isAllowed = host === "phonepe.com" || host.endsWith(".phonepe.com");
      } catch { /* malformed URL, isAllowed stays false */ }
    }
    if (!isAllowed) {
      // This exact silent-rejection path was the root cause of a real
      // student-facing bug (allowlist missed a valid PhonePe subdomain,
      // payment page never opened, no error anywhere) that took a
      // screenshot + manual DB archaeology to diagnose. Report it so any
      // future occurrence — a new PhonePe domain pattern, a malformed
      // URL, anything — shows up immediately in Vercel's runtime logs
      // instead of requiring that again.
      fetch("/api/payment-funnel-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "redirect_blocked_by_allowlist", detail: { url } }),
      }).catch(() => {}); // logging must never itself block the user
      setShowFallback(true);
      return;
    }

    const t = setTimeout(() => { window.location.href = url; }, 100);
    // Only reveal fallback instructions if we're still on this page a few
    // seconds later — i.e. the redirect above genuinely didn't take the
    // user anywhere (no app installed to handle the scheme, browser
    // blocked it, etc). A normal successful redirect navigates away well
    // before this fires, so it's never seen during ordinary operation.
    const fallbackTimer = setTimeout(() => setShowFallback(true), 4000);
    return () => { clearTimeout(t); clearTimeout(fallbackTimer); };
  }, [url]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-6 text-center">
      <div className="text-5xl mb-4">💳</div>
      <p className="text-lg font-semibold text-gray-800">Opening payment page…</p>
      <p className="text-sm text-gray-500 mt-2">You will be redirected to complete your payment.</p>

      {showFallback && (
        <div className="mt-6 w-full max-w-xs">
          {isPhonePeCheckout && url && (
            <>
              <p className="text-sm text-gray-500 mb-3">
                Nothing opened automatically. Tap below to open the payment page directly:
              </p>
              <a
                href={url}
                className="inline-block w-full bg-blue-700 text-white font-semibold rounded-xl px-4 py-3 text-sm"
              >
                Open Payment Page →
              </a>
            </>
          )}

          {!isPhonePeCheckout && upiId && (
            <>
              <p className="text-sm text-gray-500 mb-3">
                Nothing opened automatically. Pay manually using this UPI ID:
              </p>
              <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-4 py-3">
                <span className="flex-1 text-sm font-mono text-gray-800 text-left truncate">{upiId}</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(upiId!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="text-xs font-semibold text-blue-700 shrink-0"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </>
          )}

          {!isPhonePeCheckout && !upiId && (
            <p className="text-sm text-gray-500">
              Nothing opened automatically. Please go back and try again.
            </p>
          )}

          <button
            onClick={() => window.history.back()}
            className="text-xs text-blue-500 underline mt-4"
          >
            ← Go back
          </button>
        </div>
      )}
    </div>
  );
}

export default function PayRedirect() {
  return (
    <Suspense fallback={null}>
      <RedirectInner />
    </Suspense>
  );
}
