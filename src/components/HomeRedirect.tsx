"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { decideDestination } from "@/lib/route-decision";
import { recoverStuckSession } from "@/lib/pwa-recovery";

function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    Boolean((window.navigator as any).standalone);
}

export default function HomeRedirect() {
  const router = useRouter();
  const [redirecting, setRedirecting] = useState(false);
  // After 6s on the cover, show buttons so the student is never stuck on it.
  const [stuck, setStuck] = useState(false);
  const [removalNotice, setRemovalNotice] = useState<any>(null);
  const [pendingDestination, setPendingDestination] = useState<string | null>(null);

  useEffect(() => {
    const standalone = isStandalonePwa();

    /**
     * A registration hand-off still outranks an existing session — a student
     * can have a valid app session and be opening a fresh college-registration
     * link, and the pre-2026-09 order sent them to the dashboard and silently
     * lost the hand-off.
     *
     * But it must NOT outrank a session whose registration is already
     * finished. sp_pending_registration_token is written once at install and
     * was cleared in exactly one place (the "not your link" escape button), so
     * after a student completed registration it stayed in localStorage
     * forever. This block honoured it on every app open, and /register skips
     * its own "already registered?" check whenever a ?token= is present — so a
     * fully registered student was sent back to the registration form every
     * single time they opened the app.
     *
     * So the hand-off is now resolved AFTER the session check, which is the
     * only thing that knows whether the registration is done. That check is
     * async, so the decision moves inside it rather than short-circuiting
     * here.
     */
    // A normal browser tab is the public website (what visitors and payment-
    // gateway reviewers read). It must never be redirected — not to /login,
    // not into the app — or the website is unreadable. Only the installed
    // app (standalone) is routed from "/". A logged-in visitor gets into the
    // app with "Sign in", which restores the session without a new OTP.
    // An installed-app launch can also arrive as /?app=1 (manifest
    // start_url), for which the server paints a matching loading cover so
    // the marketing page never flashes before hydration. A plain browser
    // tab that somehow lands on that URL gets the cover removed here and
    // the normal website.
    if (!standalone) {
      document.getElementById("sp-launch-cover")?.remove();
      return;
    }

    const existingToken = localStorage.getItem("sp_token");
    // The "Loading…" cover — and its 6s escape (Open the app / Show the
    // website instead) — must exist on EVERY app launch, not only when a
    // session token is present. Without it, a signed-out or first-time
    // launch painted the whole marketing site inside the app until the
    // redirect committed, then swapped to /login: a visible flash on
    // every cold start. The timer is created before the branch below so
    // both paths share the one escape.
    const stuckTimer = window.setTimeout(() => {
      setStuck(true);
      try {
        void fetch("/api/client-error", { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
          body: JSON.stringify({ kind: "stuck_cover", message: "Launch cover still showing after 6s", path: window.location.pathname,
            standalone: true, role: existingToken ? "token" : "none", ua: navigator.userAgent.slice(0, 200) }) });
      } catch { /* diagnostics only */ }
    }, 6000);
    // No session at all (logged out) — do NOT wait on a network session
    // check that can only 401. That wait is what left the "Loading…"
    // cover stuck for 6–10s on logged-out launches (stuck_cover reports
    // 2026-10-25, role none, path "/"). Go straight to the destination
    // the no-session path would reach anyway: a pending registration
    // hand-off, otherwise /welcome (the Sign in / Sign up choice screen). The cover above stays up until the
    // navigation commits, so the marketing page never flashes in between.
    if (!existingToken) {
      setRedirecting(true);
      const pending = localStorage.getItem("sp_pending_registration_token");
      router.replace(pending ? `/register?token=${encodeURIComponent(pending)}` : "/welcome");
      window.setTimeout(() => {
        if (window.location.pathname === "/") {
          window.location.replace(pending ? `/register?token=${encodeURIComponent(pending)}` : "/welcome");
        }
      }, 4000);
      return () => { window.clearTimeout(stuckTimer); };
    }
    setRedirecting(true);
    // router.replace can itself stall (target chunk slow/stale after a deploy)
    // and the cover would sit on the homepage forever. If we are still on "/"
    // 4s after choosing a destination, do a hard navigation instead.
    const go = (dest: string) => {
      router.replace(dest);
      window.setTimeout(() => {
        if (window.location.pathname === "/") window.location.replace(dest);
      }, 4000);
    };
    const sessionHeaders: HeadersInit = existingToken
      ? { Authorization: `Bearer ${existingToken}` }
      : {};
    // A hung request used to leave this "Loading…" cover on screen forever —
    // the installed app launches here (manifest start_url is "/"), so that was
    // "the app won't open". Give up after 10s and treat it as a blip.
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 10000);
    fetch("/api/auth/session", { cache: "no-store", headers: sessionHeaders, signal: ctrl.signal })
      .then(async (r) => {
        window.clearTimeout(timer);
          if (r.status === 401 || r.status === 403) throw new Error("INVALID_SESSION");
          if (!r.ok) throw new Error("SESSION_TRANSIENT");
          const data = await r.json();
          if (!data?.success || !data?.data?.role) throw new Error("INVALID_SESSION");
          return data;
        })
        .then((data) => {
          localStorage.setItem("sp_role", data.data.role);
          const pendingRegistrationToken = standalone
            ? localStorage.getItem("sp_pending_registration_token")
            : null;

          // Registration finished: the hand-off is spent. Dropping it here
          // also rescues students already carrying a stale token, who have
          // nothing on their device that would otherwise clear it.
          if (data.data.is_profile_complete) {
            localStorage.removeItem("sp_pending_registration_token");
            go(decideDestination(data.data));
            return;
          }

          // Still mid-registration — the hand-off is real and takes priority.
          if (pendingRegistrationToken) {
            go(`/register?token=${encodeURIComponent(pendingRegistrationToken)}`);
            return;
          }
          go(decideDestination(data.data));
        })
        .catch((e: Error) => {
          window.clearTimeout(timer);
          // A 401 here does NOT prove the stored token is dead: the
          // session endpoint answers 401 for any getSession miss, including
          // a transient database or server error. Deleting the token on
          // one 401 permanently signed the user out even though the
          // session row was still valid (seen live 9 Nov 2026). So the
          // token is KEPT: the user is sent to /login, and a fresh code
          // login overwrites it. A truly dead token just 401s again on
          // the next open and shows the form — no harm. Only a network
          // blip, timeout or 5xx keeps the session so they are not
          // logged out every time.
          const transient = e?.message === "SESSION_TRANSIENT" || e?.name === "AbortError" || e instanceof TypeError;
          setRedirecting(false);
          // Signed in but the server was slow: open the app anyway. Its own
          // screens retry and show "Try again" — far better than /login.
          if (transient && existingToken) {
            const role = localStorage.getItem("sp_role");
            go(role === "admin" || role === "super_admin" || role === "viewer" ? "/admin" : "/dashboard");
            return;
          }
          if (standalone) {
            const pendingRegistrationToken = localStorage.getItem("sp_pending_registration_token");
            if (pendingRegistrationToken) {
              go(`/register?token=${encodeURIComponent(pendingRegistrationToken)}`);
              return;
            }
          }
          go("/welcome");
        });
    // Leaving "/" (the redirect worked) must cancel the stuck-cover report,
    // or it fires 6s later from /dashboard as a false "stuck" report.
    return () => { window.clearTimeout(stuckTimer); window.clearTimeout(timer); };
  }, [router]);

  if (removalNotice) return <div style={{position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"#f8f8fbf2",zIndex:999,padding:24}}><div style={{background:"#fff",borderRadius:20,padding:24,maxWidth:360,width:"100%"}}><div style={{fontSize:36,textAlign:"center"}}>ℹ️</div><h2 style={{fontSize:17,textAlign:"center"}}>You were previously removed{removalNotice.batch_name?` from ${removalNotice.batch_name}`:""}</h2><p style={{fontSize:13,color:"#6b7280",textAlign:"center"}}><strong>Reason:</strong> {removalNotice.reason}</p><button onClick={()=>{const dest=pendingDestination??"/register";setRemovalNotice(null);setRedirecting(true);router.replace(dest)}} style={{width:"100%",background:"#1d4ed8",color:"#fff",border:0,borderRadius:14,padding:"12px 16px",fontWeight:700}}>Continue</button></div></div>;
  if (!redirecting) return null;
  return <div style={{position:"fixed",inset:0,display:"flex",flexDirection:"column",gap:14,alignItems:"center",justifyContent:"center",background:"#f8f8fbf2",zIndex:999}}><p style={{color:"#6b7280",fontSize:14,fontWeight:600}}>Loading Student Platform…</p>{stuck && <><button onClick={()=>window.location.replace(localStorage.getItem("sp_token")?(["admin","super_admin","viewer"].includes(localStorage.getItem("sp_role")??"")?"/admin":"/dashboard"):"/welcome")} style={{background:"#0066cc",color:"#fff",border:0,borderRadius:12,padding:"12px 22px",fontWeight:600}}>Open the app</button><button onClick={()=>{ document.getElementById("sp-launch-cover")?.remove(); setRedirecting(false); }} style={{background:"transparent",color:"#6b7280",border:0,fontSize:13}}>Show the website instead</button><button onClick={()=>{ void recoverStuckSession(); }} style={{background:"#dc2626",color:"#fff",border:0,borderRadius:12,padding:"12px 22px",fontWeight:600}}>Fix the app — clear login and start again</button></>}</div>;
}
