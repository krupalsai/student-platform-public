"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// Dynamic: this page reads search params, so it must not be prerendered.
export const dynamic = "force-dynamic";

// One page, two jobs (9 Nov 2026 — gray → canonical session handoff):
//  - On the OLD (gray) domain, with no `token` param: mint a one-time,
//    5-minute token for the session this browser already holds, then send
//    the browser to the canonical domain with it.
//  - On the CANONICAL domain, with a `token` param: redeem it for a real
//    session (cookie + localStorage token), then land on `next`.
// A visitor with no session here just goes to the canonical URL; the
// canonical side then shows its normal sign-in. Nothing here ever hangs:
// every path is bounded by a 10s fallback that goes to the destination
// without a handoff.

const CANONICAL_ORIGIN = "https://studentplatform.dev";

function safeNext(raw: string | null): string {
  if (!raw) return "/";
  // Same-site path only — never let a crafted `next` send someone off-site.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function HandoffInner() {
  const params = useSearchParams();
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = params.get("token");
    const next = safeNext(params.get("next"));

    // ── Redeem mode (canonical domain) ───────────────────────────────
    if (token) {
      const fallback = window.setTimeout(() => window.location.replace(next), 10000);
      fetch("/api/auth/handoff/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token }),
      })
        .then((r) => r.json())
        .then((j) => {
          window.clearTimeout(fallback);
          if (j?.success && typeof j?.data?.token === "string") {
            window.localStorage.setItem("sp_token", j.data.token);
            // Hard navigation, not router.replace: the redeem response has
            // just set the session cookie, and a full document load
            // guarantees it is sent on the next request (a client-side
            // RSC navigation can race the cookie store).
            window.location.replace(next);
          } else {
            // Bad/expired/used token — the normal sign-in is the safe place.
            window.location.replace("/login");
          }
        })
        .catch(() => {
          window.clearTimeout(fallback);
          window.location.replace("/login");
        });
      return;
    }

    // ── Create mode (old gray domain) ────────────────────────────────
    // The mint is attempted even when localStorage has no token: the
    // session may still live in the gray cookie (localStorage and the
    // cookie are separate stores, and the login page used to delete the
    // stored token on a single 401). The create fetch sends credentials
    // so the cookie authenticates it — requireSession falls back to the
    // cookie when no Bearer token is present. Only when the server says
    // no (401) do we go to the canonical URL without a token.
    const spToken = window.localStorage.getItem("sp_token");
    const fallback = window.setTimeout(
      () => {
        window.location.href = `${CANONICAL_ORIGIN}${next}`;
      },
      10000,
    );
    fetch("/api/auth/handoff/create", {
      method: "POST",
      headers: spToken ? { Authorization: `Bearer ${spToken}` } : {},
      credentials: "same-origin",
    })
      .then((r) => r.json())
      .then((j) => {
        window.clearTimeout(fallback);
        if (j?.success && typeof j?.data?.token === "string") {
          window.location.href = `${CANONICAL_ORIGIN}/handoff?token=${encodeURIComponent(j.data.token)}&next=${encodeURIComponent(next)}`;
        } else {
          window.location.href = `${CANONICAL_ORIGIN}${next}`;
        }
      })
      .catch(() => {
        window.clearTimeout(fallback);
        window.location.href = `${CANONICAL_ORIGIN}${next}`;
      });
  }, [params, router]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
        color: "#111827",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <p style={{ fontSize: 15 }}>Signing you in…</p>
    </div>
  );
}

export default function HandoffPage() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#ffffff",
            color: "#111827",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <p style={{ fontSize: 15 }}>Signing you in…</p>
        </div>
      }
    >
      <HandoffInner />
    </Suspense>
  );
}
