"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Reports crashes and reload loops from the phone to /api/client-error, so a
 * "the app keeps crashing" report can be read instead of guessed at (item
 * #240). Sends no personal data: the error text, the screens visited in the
 * last few seconds, the device type, whether it runs as an installed app, and
 * the role. Mounted first in the root layout so it is listening before any
 * other component can fail.
 */
const TRAIL_KEY = "sp_trail";
const MAX_REPORTS_PER_LOAD = 6;

function standalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true);
}

function readTrail(): string[] {
  try { return JSON.parse(sessionStorage.getItem(TRAIL_KEY) ?? "[]"); } catch { return []; }
}

function send(kind: "error" | "rejection" | "boundary" | "reload_loop", message: string, stack?: string) {
  try {
    const payload = JSON.stringify({
      kind, message: message.slice(0, 400), stack: stack?.slice(0, 1500),
      path: location.pathname + location.search.replace(/token=[^&]+/i, "token=…").slice(0, 80),
      trail: readTrail().slice(-25), standalone: standalone(),
      role: localStorage.getItem("sp_role") ?? undefined, ua: navigator.userAgent.slice(0, 220),
    });
    // sendBeacon survives the page being torn down by the very crash we report.
    if (!(navigator.sendBeacon && navigator.sendBeacon("/api/client-error", new Blob([payload], { type: "application/json" })))) {
      void fetch("/api/client-error", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(() => {});
    }
  } catch { /* the reporter must never be the thing that fails */ }
}

export default function ClientErrorReporter() {
  const pathname = usePathname();

  useEffect(() => {
    let sent = 0;
    const seen = new Set<string>();
    const report = (kind: "error" | "rejection", message: string, stack?: string) => {
      // Browser extensions (userscripts, ad blockers) throw errors we cannot
      // fix and that are not the app's — don't let them drown real reports.
      if (stack && /(chrome|moz|safari-web)-extension:\/\//.test(stack)) return;
      const key = `${kind}:${message}`;
      if (sent >= MAX_REPORTS_PER_LOAD || seen.has(key)) return;
      seen.add(key); sent++;
      send(kind, message, stack);
    };
    const onError = (e: ErrorEvent) => report("error", e.message || "Script error", e.error?.stack);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      report("rejection", r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    // Reload-loop detector: many page loads within seconds is the "crashing
    // every second" symptom. Report once, with the screens that were visited.
    try {
      const now = Date.now();
      const loads: number[] = JSON.parse(localStorage.getItem("sp_loads") ?? "[]").filter((t: number) => now - t < 15000);
      loads.push(now);
      localStorage.setItem("sp_loads", JSON.stringify(loads));
      if (loads.length >= 6 && !sessionStorage.getItem("sp_loop_reported")) {
        sessionStorage.setItem("sp_loop_reported", "1");
        send("reload_loop", `${loads.length} page loads in 15s`);
      }
    } catch { /* storage blocked */ }

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Breadcrumbs: which screens, in what order, how fast.
  useEffect(() => {
    try {
      const trail = readTrail();
      trail.push(`${new Date().toISOString().slice(11, 19)} ${pathname}`);
      sessionStorage.setItem(TRAIL_KEY, JSON.stringify(trail.slice(-25)));
    } catch { /* ignore */ }
  }, [pathname]);

  return null;
}
