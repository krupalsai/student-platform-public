"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { decideDestination } from "@/lib/route-decision";
import { APP_BUILD_ID } from "@/lib/app-version";

/**
 * Pass-through hand-off page (14 Nov 2026, simple flow): the bot's link
 * lands here with a registration token, and this page sends the student
 * straight to their destination — registration, or the home page when
 * there is no token. It never shows an install button and never gates
 * anything; install is offered by the browser itself.
 * The registration token is persisted locally so that, after the student
 * opens the newly installed app, the app can resume at the intended
 * registration flow without exposing registration in the browser.
 */
export default function InstallStudentAppBody({ token = "", next = "" }: { token?: string; next?: string }) {
  const router = useRouter();
  const [postInstall, setPostInstall] = useState(false);
  const [hasPendingToken, setHasPendingToken] = useState(false);
  // The installed app always redirects from here, so it must never flash the
  // "install the app" UI while the session check below is in flight.
  const [resolving, setResolving] = useState(false);

  // Stale-tab guard (14 Nov 2026): a Chrome tab opened BEFORE a deploy
  // keeps showing that deploy's old page — the server cannot serve it
  // stale (/install is no-cache, no-store), the phone's own open tab is
  // the stale copy, and PwaBootstrap's update checks deliberately do not
  // run on /install. So this page checks the live build id itself, on
  // mount and whenever it comes back into view (including a back-forward
  // cache restore), and reloads once onto the new build when it is old.
  // At most one reload per server build per tab session — never a loop.
  // This cannot fix a tab that is ALREADY stale before this deploy (that
  // tab runs old code with no check in it); that student still needs the
  // one line: close the tab, open a fresh tab to studentplatform.dev/install.
  useEffect(() => {
    let cancelled = false;
    const RELOAD_KEY = "sp_version_reload_for";
    const checkFresh = async () => {
      if (cancelled) return;
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        const serverBuild: unknown = j?.data?.build ?? j?.build ?? null;
        if (typeof serverBuild !== "string" || !serverBuild || serverBuild === APP_BUILD_ID || cancelled) return;
        try {
          if (sessionStorage.getItem(RELOAD_KEY) === serverBuild) return;
          sessionStorage.setItem(RELOAD_KEY, serverBuild);
        } catch {
          // Storage blocked — still reload once; after the reload the
          // new build matches the server and the check stops by itself.
        }
        window.location.reload();
      } catch {
        // Offline — leave the page exactly as it is.
      }
    };
    void checkFresh();
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void checkFresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkFresh();
    };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (token) localStorage.setItem("sp_pending_registration_token", token);
    if (next && next.startsWith("/") && !next.startsWith("//")) {
      localStorage.setItem("sp_pending_app_path", next);
    }

    const standalone = window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: fullscreen)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches ||
      window.matchMedia("(display-mode: window-controls-overlay)").matches ||
      (window.navigator as any).standalone === true;

    const pendingToken = token || localStorage.getItem("sp_pending_registration_token");
    const rawAppPath = next || localStorage.getItem("sp_pending_app_path") || "/";
    const safePath = rawAppPath.startsWith("/") && !rawAppPath.startsWith("//") ? rawAppPath : "/";
    setHasPendingToken(Boolean(pendingToken));

    const installedMarker = localStorage.getItem("sp_pwa_installed");
    const installedAt = Number(localStorage.getItem("sp_pwa_installed_at"));
    const freshInstall = installedMarker === "1" && Number.isFinite(installedAt) &&
      Date.now() - installedAt >= 0 && Date.now() - installedAt <= 10 * 60 * 1000;

    if (standalone) setResolving(true);

    const toPending = () =>
      pendingToken ? `/register?token=${encodeURIComponent(pendingToken)}` : safePath;

    let cancelled = false;

    (async () => {
      /**
       * Who is this link for, and have they already registered?
       *
       * Both questions have to be answered BEFORE anything is cleared or
       * redirected. Previously a `?token=` in the URL unconditionally deleted
       * sp_token/sp_role on the reasoning that a hand-off is a new identity —
       * true only when the link belongs to someone else. WhatsApp links stay
       * in a student's chat forever, so an already-registered student
       * re-tapping their OWN old link was logged out and pushed back into
       * registration; and because start_url is /install, every later launch
       * repeated it. That is the "many students" case.
       */
      let tokenProfileId: string | null = null;
      let tokenComplete = false;
      if (pendingToken) {
        try {
          const r = await fetch("/api/registration-tokens/validate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ token: pendingToken }),
          });
          if (r.ok) {
            const j = await r.json();
            tokenProfileId = j?.data?.profile_id ?? null;
            tokenComplete = Boolean(j?.data?.is_profile_complete);
          }
        } catch {
          // Unreachable: fall through to the pre-existing behaviour below.
        }
      }

      let session: { role: string; is_profile_complete: boolean; profile_id?: string } | null = null;
      const sessionToken = localStorage.getItem("sp_token");
      if (sessionToken) {
        try {
          const r = await fetch("/api/auth/session", {
            cache: "no-store",
            headers: { Authorization: `Bearer ${sessionToken}` },
          });
          if (r.ok) {
            const j = await r.json();
            if (j?.success && j?.data?.role) session = j.data;
          }
        } catch {
          // Treated as no session.
        }
      }

      // Only a link belonging to a DIFFERENT person is a new identity context.
      // That case is real (a shared or test device, items #133/#134) and still
      // clears the session; re-tapping your own link no longer does.
      if (token && session && tokenProfileId && session.profile_id && session.profile_id !== tokenProfileId) {
        localStorage.removeItem("sp_token");
        localStorage.removeItem("sp_role");
        session = null;
      }

      if (cancelled) return;

      if (!standalone) {
        // (14 Nov 2026, simple flow): this page no longer gates anything.
        // A browser tab goes straight to its destination — registration
        // when there is a token, the home page otherwise. Install is
        // offered by the browser itself (Chrome's Install banner/menu),
        // never by a button on this page.
        if (freshInstall && pendingToken) { setPostInstall(true); return; }
        router.replace(toPending());
        return;
      }

      if (session) {
        localStorage.setItem("sp_role", session.role);
        // Registration finished: the hand-off is spent. Dropping it here also
        // rescues students already carrying a stale token — nothing else on
        // their device would ever clear it.
        if (session.is_profile_complete) {
          localStorage.removeItem("sp_pending_registration_token");
          localStorage.removeItem("sp_pending_app_path");
          router.replace(decideDestination(session));
          return;
        }
        // Still mid-registration — the hand-off is real and takes priority.
        router.replace(toPending());
        return;
      }

      // No session, but the link's owner has already registered: the form has
      // nothing left to collect, so send them to sign in instead of showing it.
      if (pendingToken && tokenComplete) {
        localStorage.removeItem("sp_pending_registration_token");
        router.replace("/login");
        return;
      }

      localStorage.removeItem("sp_pending_app_path");
      router.replace(toPending());
    })();

    return () => { cancelled = true; };
  }, [token, next, router]);

  if (resolving) {
    return <div className="text-center text-sm opacity-70">Opening Student App…</div>;
  }

  if (postInstall) {
    return (
      <div className="space-y-3 text-center text-sm">
        <p className="font-semibold text-lg">Student App installed</p>
        {hasPendingToken ? (
          <>
            <p className="opacity-80">
              Open <strong>Student App</strong> from your home screen. Your registration will open automatically.
            </p>
            <p className="opacity-70">Your registration link is saved, so you do not need to enter your details again.</p>
          </>
        ) : (
          <p className="opacity-80">
            Open <strong>Student App</strong> from your home screen to continue — this browser tab is done.
          </p>
        )}
      </div>
    );
  }

  return <p className="text-center text-sm opacity-70">Opening Student App…</p>;
}
