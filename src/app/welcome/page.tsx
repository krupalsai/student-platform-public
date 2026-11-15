"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GraduationCap, LogIn, UserPlus } from "lucide-react";
import { decideDestination } from "@/lib/route-decision";
import { ui } from "@/lib/student-ui";

// Entry screen — the FIRST thing a signed-out visitor sees.
//
// Two clear choices, nothing else: "Sign in" (I already have an account)
// and "Sign up" (I'm new). No form is dumped on the visitor first. A
// signed-in visitor is sent straight to their destination, so this screen
// never traps someone who is already logged in.
export default function WelcomePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const token = window.localStorage.getItem("sp_token");
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    fetch("/api/auth/session", { cache: "no-store", headers, signal: controller.signal })
      .then(async (r) => {
        window.clearTimeout(timeout);
        if (!r.ok) throw new Error("NO_SESSION");
        const data = await r.json().catch(() => null);
        if (!data?.success || !data?.data?.role) throw new Error("NO_SESSION");
        if (cancelled) return;
        router.replace(decideDestination(data.data));
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [router]);

  if (checking) {
    return (
      <main style={{ minHeight: "100dvh", background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ textAlign: "center", color: ui.textSecondary }}>
          <div style={{ fontWeight: 600, color: ui.textPrimary }}>Loading…</div>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100dvh", background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440, background: ui.surface, borderRadius: 24, border: `1px solid ${ui.border}`, padding: "42px 34px", boxShadow: ui.shadow.card }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 50, height: 50, borderRadius: ui.radius.tile, background: ui.textPrimary, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
            <GraduationCap size={24} strokeWidth={1.8} />
          </div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-.03em", color: ui.textPrimary }}>Student Platform</h1>
          <p style={{ margin: "8px 0 0", color: ui.textSecondary, fontSize: 14 }}>
            Your student account, in one place.
          </p>
        </div>

        <Link
          href="/login"
          style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "16px", background: ui.textPrimary, color: "#fff", fontWeight: 600, fontSize: 16, textDecoration: "none", marginBottom: 12 }}
        >
          <LogIn size={20} />
          <span>
            <span style={{ display: "block" }}>Sign in</span>
            <span style={{ display: "block", fontWeight: 400, fontSize: 13, opacity: 0.85 }}>I already have an account</span>
          </span>
        </Link>

        <Link
          href="/signup"
          style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "16px", background: ui.surface, color: ui.textPrimary, fontWeight: 600, fontSize: 16, textDecoration: "none" }}
        >
          <UserPlus size={20} />
          <span>
            <span style={{ display: "block" }}>Sign up</span>
            <span style={{ display: "block", fontWeight: 400, fontSize: 13, color: ui.textSecondary }}>I&apos;m new — create my account</span>
          </span>
        </Link>

        <p style={{ margin: "22px 0 0", textAlign: "center", color: ui.textTertiary, fontSize: 12 }}>
          For GNIT, GNITC, BIET and more colleges. If your college isn&apos;t listed, you can still sign up — we&apos;ll add it.
        </p>
      </div>
    </main>
  );
}
