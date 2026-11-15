"use client";

import { useState } from "react";
import { recoverStuckSession } from "@/lib/pwa-recovery";
import DiagnosePanel from "@/components/DiagnosePanel";

/**
 * Standalone repair page (14 Nov 2026, the Vivo stuck-launch case).
 *
 * When the installed app is stuck on "Loading Student Platform…" the
 * student has nothing to tap — the side menu never appears. This page
 * is reachable WITHOUT the menu, as a plain URL they can open in Chrome:
 * studentplatform.dev/fix. One big button clears the stuck login session
 * (this phone only — profile, batch and payments on the server are
 * untouched) and opens a fresh sign-in. The diagnose panel underneath
 * checks the rest.
 *
 * The page is public and is listed in StudentAppOnlyGate's open paths,
 * so a plain browser tab is never bounced to /install from it.
 */
export default function FixAppPage() {
  const [fixing, setFixing] = useState(false);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <section className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-semibold">Fix the Student App</h1>
        <p className="text-sm opacity-80">
          App stuck on loading, or the menu never appears? Tap below. It clears the stuck login on this
          phone and opens a fresh sign-in. Your registration, batch and payments are not touched.
        </p>
        <button
          type="button"
          className="w-full rounded-2xl px-6 py-4 text-lg font-bold text-white bg-[#111827] shadow-lg active:scale-[0.98] transition disabled:opacity-60"
          disabled={fixing}
          onClick={() => {
            setFixing(true);
            void recoverStuckSession();
          }}
        >
          {fixing ? "Fixing the app…" : "Fix my app"}
        </button>
        <p className="text-sm opacity-70">
          If the app still won&apos;t open, open this page in Chrome: <strong>studentplatform.dev/fix</strong>
        </p>
        <div className="pt-2 text-left">
          <DiagnosePanel />
        </div>
      </section>
    </main>
  );
}
