"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { decideDestination, canUseStudentView, type Destination } from "@/lib/route-decision";

/** Defense-in-depth guard. The server session is authoritative. */
export function useRoleGuard(expected: Destination): { checking: boolean } {
  const router = useRouter();
  // An admin's read-only Dashboard Preview (see admin/preview/page.tsx) uses
  // its own short-lived token passed in the URL, not localStorage — this
  // guard's job (confirm the LOCAL session's role matches this page) doesn't
  // apply there, since the token is a real but deliberately temporary
  // student session an admin generated on purpose, not this browser's own.
  // Read straight from window.location rather than useSearchParams() so this
  // hook's two call sites don't each need their own Suspense boundary.
  const previewToken = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("preview_token")
    : null;
  const [checking, setChecking] = useState(!previewToken);

  useEffect(() => {
    if (previewToken) return;
    let active = true;
    const token = localStorage.getItem("sp_token");
    // A valid session can live only in the HttpOnly cookie (no sp_token copy
    // in localStorage). /login accepts that session and sends the person
    // here, so bouncing to /login just because the localStorage copy is
    // missing makes the two pages redirect each other forever. Ask the
    // server (cookie) before deciding; only a rejected session goes to /login.
    // The fetch had no timeout at all: on a slow phone it could hang for
    // minutes and then resolve 401, yanking the user to /login long after
    // the page had rendered. Bound it; an abort is a transient blip (the
    // catch already treats AbortError as one, and the token is kept).
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 15000);
    fetch("/api/auth/session", {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    })
      .then(async (r) => {
        window.clearTimeout(timer);
        if (r.status === 401 || r.status === 403) throw new Error("INVALID_SESSION");
        if (!r.ok) throw new Error("SESSION_TRANSIENT");
        const data = await r.json();
        if (!data?.success || !data?.data?.role) throw new Error("INVALID_SESSION");
        return data.data as { role: string; is_profile_complete: boolean; batch_id?: string | null };
      })
      .then((data) => {
        if (!active) return;
        localStorage.setItem("sp_role", data.role);
        const destination = decideDestination(data);
        if (destination !== expected) {
          // One exception: an admin who is ALSO enrolled in a batch may open
          // the student side deliberately (the "My Registration" switch on the
          // admin console). Without this they were bounced straight back to
          // /admin from every student page and could never pay their own fee.
          // Only ever widens access to /dashboard — /admin stays role-gated.
          const dualRoleStudentView = expected === "/dashboard" && canUseStudentView(data);
          if (!dualRoleStudentView) {
            router.replace(destination);
            return;
          }
        }
        setChecking(false);
      })
      .catch((e: Error) => {
        window.clearTimeout(timer);
        if (!active) return;
        // A network blip, abort or 5xx must NOT sign the user out — only a
        // real rejection of the token does. A fetch that never answered
        // (TypeError / AbortError) is a blip, not a rejection: the old code
        // only recognised the literal SESSION_TRANSIENT message, so a blip
        // fell through to the branch below, which DELETED the stored token.
        // That deletion is what let /admin and /login disagree about the
        // session and bounce the user between them (loop, 10 Nov 2026):
        // /admin deleted the token and went to /login, /login restored
        // the session from the cookie and sent the user back to /admin,
        // where the check failed again. The token is KEPT on every failure
        // here now: /login's own restore keeps it too, and a fresh OTP
        // overwrites a truly dead one. A stale cached role must never
        // expose /admin to a student — but that is enforced by each page's
        // own live session check (the admin console renders nothing until
        // the server confirms the role), not by deleting the token here.
        const transient =
          e?.message === "SESSION_TRANSIENT" ||
          e?.name === "AbortError" ||
          e instanceof TypeError;
        if (transient) {
          if (expected === "/dashboard" && localStorage.getItem("sp_role") === "student") { setChecking(false); return; }
          // On /admin, a blip must not bounce to /login at all: the admin
          // page runs its own session check and shows its own retry state.
          // Bouncing here is the /admin -> /login leg of the loop.
          if (expected === "/admin") { setChecking(false); return; }
          router.replace("/login");
          return;
        }
        router.replace("/login");
      });

    return () => { active = false; window.clearTimeout(timer); };
  }, [router, expected, previewToken]);

  return { checking };
}
