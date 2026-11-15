"use client";

import { useEffect } from "react";

/**
 * Last-resort screen for an error that escapes every other boundary. The
 * commonest real cause is a deploy landing while the app is open: the page
 * asks for a script file that no longer exists. One automatic reload fixes
 * that; if it happens again we show a button instead of looping.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[global-error]", error);
    try {
      const body = JSON.stringify({ kind: "boundary", message: String(error?.message ?? "error").slice(0, 400), stack: error?.stack?.slice(0, 1500), path: location.pathname, standalone: window.matchMedia?.("(display-mode: standalone)").matches, role: localStorage.getItem("sp_role") ?? undefined, ua: navigator.userAgent.slice(0, 220) });
      navigator.sendBeacon?.("/api/client-error", new Blob([body], { type: "application/json" }));
    } catch { /* best effort */ }
    try {
      if (!sessionStorage.getItem("sp_error_reloaded")) {
        sessionStorage.setItem("sp_error_reloaded", String(Date.now()));
        window.location.reload();
      }
    } catch { /* storage blocked: just show the button */ }
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f2f2f7", color: "#1c1c1e" }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
          <div style={{ maxWidth: 340 }}>
            <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: "#6e6e73", margin: "0 0 20px" }}>The app was updated while it was open. Reload to continue.</p>
            <button
              onClick={() => { try { sessionStorage.removeItem("sp_error_reloaded"); } catch {} reset(); window.location.reload(); }}
              style={{ background: "#007aff", color: "#fff", border: 0, borderRadius: 12, padding: "13px 28px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
