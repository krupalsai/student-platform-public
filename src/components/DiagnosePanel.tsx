"use client";

import { useState } from "react";
import { ui } from "@/lib/student-ui";
import { recoverStuckSession } from "@/lib/pwa-recovery";

/**
 * "App not working? Tap here — it will check and fix it."
 *
 * Lives on the login screen (the screen students get stuck on). The student
 * types their registered number, taps one button, and gets a plain-language
 * diagnosis plus ONE fix — a fresh login code, a link back into the app, a
 * payment retry, or the clear-data steps. When nothing in their record
 * explains it, the panel files a support report itself and says so: the
 * student never needs to find anyone to tell.
 *
 * Client checks run first (is the site reachable at all, is there a saved
 * login, is the browser online) and are sent along as the `error` hint, so
 * the server diagnosis can tell "the site is down for everyone" apart from
 * "your account is the problem".
 */
type Fix = {
  kind: string;
  label: string;
  url: string | null;
  note: string;
};

type Result = {
  issue: string;
  title: string;
  detail: string;
  fix: Fix;
};

const SCREEN_CHOICES = [
  { id: "login", label: "Login / code screen" },
  { id: "after_login", label: "After login — app opens but stuck" },
  { id: "payment", label: "Payment screen" },
  { id: "case", label: "Case status screen" },
  { id: "other", label: "Something else" },
];

export default function DiagnosePanel({
  phone: initialPhone,
  onClose,
}: {
  phone?: string;
  onClose?: () => void;
}) {
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [screen, setScreen] = useState("login");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [ticketFiled, setTicketFiled] = useState(false);
  const [error, setError] = useState("");

  async function runCheck() {
    const number = phone.trim();
    if (!number) {
      setError("Enter your registered mobile number first.");
      return;
    }
    setError("");
    setResult(null);
    setTicketFiled(false);
    setChecking(true);
    // Client-side checks: reachable, online, saved login?
    let clientHint = "";
    try {
      const ctrl = new AbortController();
      const t = window.setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
      window.clearTimeout(t);
      if (!res.ok) clientHint += "site not reachable; ";
    } catch {
      clientHint += "site not reachable; ";
    }
    if (!window.navigator.onLine) clientHint += "phone offline; ";
    if (!window.localStorage.getItem("sp_token")) clientHint += "no saved login; ";
    const screenLabel = SCREEN_CHOICES.find((c) => c.id === screen)?.label ?? screen;
    // The diagnose call must never spin forever (14 Nov 2026: the check
    // sat doing nothing for minutes — the server's court-case lookup can
    // stall, and this fetch had no time limit at all). 15s, then a plain
    // "try again" instead of a stuck spinner.
    try {
      const ctrl = new AbortController();
      const t = window.setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: number,
          screen: screenLabel,
          error: clientHint ? `client checks: ${clientHint}` : undefined,
          device: window.navigator.userAgent.slice(0, 200),
        }),
        signal: ctrl.signal,
      });
      window.clearTimeout(t);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error ?? "The check failed. Try again.");
      setResult(data.data.diagnosis as Result);
      setTicketFiled(!!data.data.ticketFiled);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("The check is taking too long — try again.");
      } else {
        setError(e instanceof Error ? e.message : "The check failed. Try again.");
      }
    } finally {
      setChecking(false);
    }
  }

  // Full stuck-session reset: not just the token — the service worker and
  // cached app files too (the Vivo stuck-launch case, 14 Nov 2026). The
  // recovery only runs on the student's tap and touches this phone only.
  function clearLoginAndRetry() {
    void recoverStuckSession();
  }

  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: ui.radius.button,
        background: ui.accentSoft,
        border: `1px solid ${ui.border}`,
        fontSize: 14,
        lineHeight: 1.55,
        color: ui.textPrimary,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>App not working? Let&apos;s check it.</div>
      <p style={{ margin: "0 0 12px", color: ui.textSecondary, fontSize: 13 }}>
        This checks your account and your phone, then tells you the fix — or reports it for you.
      </p>

      {!result && (
        <>
          <label style={{ display: "block", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            Your registered mobile number
          </label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            autoComplete="off"
            placeholder="10-digit mobile number"
            style={{
              width: "100%",
              boxSizing: "border-box",
              border: `1px solid ${ui.borderStrong}`,
              borderRadius: ui.radius.button,
              padding: "12px 14px",
              fontSize: 15,
              outline: "none",
            }}
          />
          <div style={{ fontWeight: 600, fontSize: 13, margin: "14px 0 6px" }}>Where are you stuck?</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {SCREEN_CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setScreen(c.id)}
                style={{
                  border: `1px solid ${screen === c.id ? ui.textPrimary : ui.borderStrong}`,
                  background: screen === c.id ? ui.textPrimary : "#fff",
                  color: screen === c.id ? "#fff" : ui.textPrimary,
                  borderRadius: 999,
                  padding: "8px 12px",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={runCheck}
            disabled={checking}
            style={{
              width: "100%",
              marginTop: 16,
              border: 0,
              borderRadius: ui.radius.button,
              padding: "14px 16px",
              background: ui.textPrimary,
              color: "#fff",
              fontWeight: 600,
              fontSize: 15,
              opacity: checking ? 0.6 : 1,
              cursor: "pointer",
            }}
          >
            {checking ? "Checking…" : "Check and fix it"}
          </button>
          {error && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: ui.radius.button, background: ui.dangerSoft, color: ui.danger, fontSize: 13, fontWeight: 500 }}>
              {error}
            </div>
          )}
        </>
      )}

      {result && (
        <>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{result.title}</div>
          <p style={{ margin: "0 0 12px", color: ui.textSecondary, fontSize: 13 }}>{result.detail}</p>
          {result.fix.url ? (
            <a
              href={result.fix.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block",
                textAlign: "center",
                textDecoration: "none",
                borderRadius: ui.radius.button,
                padding: "14px 16px",
                background: "#25D366",
                color: "#fff",
                fontWeight: 600,
                fontSize: 15,
              }}
            >
              {result.fix.label}
            </a>
          ) : result.fix.kind === "clear_data" ? (
            <button
              type="button"
              onClick={clearLoginAndRetry}
              style={{
                width: "100%",
                border: 0,
                borderRadius: ui.radius.button,
                padding: "14px 16px",
                background: ui.textPrimary,
                color: "#fff",
                fontWeight: 600,
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              {result.fix.label}
            </button>
          ) : (
            <div style={{ fontWeight: 600, fontSize: 14 }}>{result.fix.label}</div>
          )}
          <p style={{ margin: "12px 0 0", color: ui.textSecondary, fontSize: 13 }}>{result.fix.note}</p>
          {ticketFiled && (
            <p style={{ margin: "10px 0 0", fontSize: 13, fontWeight: 600 }}>
              Reported — we are fixing it. No need to message anyone.
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setTicketFiled(false);
            }}
            style={{
              marginTop: 14,
              border: 0,
              background: "transparent",
              color: ui.accent,
              fontWeight: 500,
              fontSize: 13,
              cursor: "pointer",
              padding: "6px 0",
            }}
          >
            Check again
          </button>
        </>
      )}

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          style={{
            marginTop: 10,
            border: 0,
            background: "transparent",
            color: ui.textSecondary,
            fontSize: 13,
            cursor: "pointer",
            padding: "6px 0",
          }}
        >
          Close
        </button>
      )}
    </div>
  );
}
