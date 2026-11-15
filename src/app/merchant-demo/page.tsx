"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * The public front door for the merchant-demo login (see
 * api/merchant-demo/login/route.ts for what this actually provisions and
 * why). Reads ?key=, exchanges it for a real session token, stores it the
 * same way every other login on this app does, then hands off to the
 * normal student flow — /register if the demo profile hasn't completed
 * registration yet, /dashboard if it already has.
 */
function MerchantDemoInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    const key = params.get("key") ?? "";
    if (!key) {
      setError("This link is missing its access key.");
      return;
    }
    // Clear any existing session FIRST, before the demo login runs. A stale
    // admin/student session on the same device otherwise wins the race:
    // the homepage redirect reads the old role and sends the reviewer to
    // the admin console, and the demo token then lands on a loading cover.
    // Cashfree reviewers have no session at all, but the owner's own phone
    // does — this makes the link work the same way on both.
    try {
      localStorage.removeItem("sp_token");
      localStorage.removeItem("sp_role");
      localStorage.removeItem("sp_merchant_demo");
    } catch { /* storage unavailable — the fetch below will fail cleanly */ }
    fetch("/api/merchant-demo/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    })
      .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))
      .then(({ status, json }) => {
        if (status !== 200 || !json?.success) {
          setError("This link is invalid or no longer active.");
          return;
        }
        localStorage.setItem("sp_token", json.data.token);
        localStorage.setItem("sp_role", json.data.role);
        // Gateway reviewers use a plain web browser — they will not install
        // the PWA. Mark this session as a merchant-demo session so
        // StudentAppOnlyGate lets it reach /register and /dashboard on the
        // web. This is a UX flag only: the gate is not access control, the
        // APIs still authorise every request, and the demo profile is an
        // isolated, incomplete profile on its own PGDEMO batch.
        localStorage.setItem("sp_merchant_demo", "1");
        router.replace(json.data.is_profile_complete ? "/dashboard" : "/register");
      })
      .catch(() => setError("Something went wrong. Please try again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", background: "#f8fafc" }}>
      <p style={{ color: error ? "#dc2626" : "#6b7280", fontSize: 14, textAlign: "center", maxWidth: 320 }}>
        {error || "Loading…"}
      </p>
    </div>
  );
}

export default function MerchantDemoPage() {
  return (
    <Suspense fallback={null}>
      <MerchantDemoInner />
    </Suspense>
  );
}
