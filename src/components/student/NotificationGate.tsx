"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { getVapidPublicKey, isPushSupported, requestAndSubscribeToPush, syncPushSubscription } from "@/lib/push/subscribe-client";
import { Bell, BellOff, CheckCircle2, Smartphone } from "lucide-react";
import { ui } from "@/lib/student-ui";

/** Set only when the installed app genuinely cannot do push (old iOS). */
const NO_PUSH_ACK_KEY = "sp_notif_unsupported_ack";

/** Public/pre-login screens the gate never covers. */
const OPEN_PATHS = ["/login", "/install", "/register", "/fix", "/terms", "/privacy-policy", "/refund-policy", "/shipping-policy", "/contact", "/merchant-demo", "/college-search"];

type Stage = "hidden" | "ask" | "busy" | "granted" | "denied" | "install" | "old-device";

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Notifications are REQUIRED to use the Student App (explicit request,
 * 2026-10-04): announcements, payment approvals, case updates and — since
 * item #220 — login codes all arrive as app notifications. A signed-in
 * student whose browser has not granted permission sees this full screen on
 * every launch until they turn it on. There is no skip.
 *
 * Admins are never blocked by this screen. If an admin's device already
 * granted permission, the gate still silently links that device to the admin
 * account in the background (otherwise no admin — including the owner — ever
 * gets a push subscription, and the admin push-test has nothing to send to).
 *
 * It only blocks on the STUDENT'S choice, never on our infrastructure: if the
 * server's push keys are missing or a subscribe call fails after permission
 * was granted, the app opens and the subscription is retried on the next
 * launch. And it never strands anyone:
 *   - permission blocked earlier → step-by-step "turn it back on" + recheck
 *     (browsers forbid re-asking from code, but settings always can);
 *   - iPhone in Safari → install the app (iOS only allows web notifications
 *     for installed apps);
 *   - installed app that still has no push support (iOS older than 16.4) →
 *     the only case allowed through, with WhatsApp as the update channel.
 */
export default function NotificationGate() {
  const pathname = usePathname();
  const [stage, setStage] = useState<Stage>("hidden");
  const [errorText, setErrorText] = useState("");

  const evaluate = useCallback(async () => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
    if (w.Capacitor?.isNativePlatform?.()) return setStage("hidden"); // native app: FCM
    if (new URLSearchParams(window.location.search).get("preview_token")) return setStage("hidden"); // admin preview
    if (pathname === "/" || OPEN_PATHS.some(p => pathname?.startsWith(p))) return setStage("hidden");

    // Session and role come from the server, not localStorage: a signed-in
    // user can hold a valid sp_session cookie while localStorage has no
    // sp_token (handoff race, direct visit, cleared storage), and the
    // stale localStorage role copy is what used to render the admin
    // console on a dead session. If the check cannot be answered, hide —
    // the gate retries on the next launch/focus, exactly as it does today
    // when there is no token.
    let role: string | null = null;
    try {
      const sessionRes = await Promise.race([
        fetch("/api/auth/session", { cache: "no-store" }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (!sessionRes) return setStage("hidden");
      const sessionJson = await sessionRes.json().catch(() => null);
      if (!sessionRes.ok || sessionJson?.success !== true) return setStage("hidden");
      role = sessionJson?.data?.role ?? null;
    } catch {
      return setStage("hidden");
    }
    const isStaff = role === "admin" || role === "super_admin";
    if (role !== "student" && !isStaff) return setStage("hidden");

    if (!isPushSupported()) {
      // (14 Nov 2026): the ack is read here, not only on the standalone
      // branch — a browser user who tapped Continue must not get the gate
      // back on every focus/navigation.
      if (window.localStorage.getItem(NO_PUSH_ACK_KEY)) return setStage("hidden");
      if (isStandalone()) return setStage("old-device");
      return setStage(isIos() ? "install" : "old-device");
    }

    // Admins are never blocked by this gate — but if this device already
    // granted notification permission, keep it linked to the admin account
    // so the admin push-test (and admin alerts) can reach this phone.
    // Before this, no admin ever got a subscription: the gate was
    // student-only, so an admin's phone could have notifications on at OS
    // level and still have no stored subscription to test against.
    if (isStaff) {
      if (Notification.permission === "granted") {
        try {
          await getVapidPublicKey();
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub) await syncPushSubscription(sub);
          else await requestAndSubscribeToPush();
        } catch (e) {
          console.warn("[notification-gate] admin background subscribe failed; retrying next launch", e);
        }
      }
      return setStage("hidden");
    }

    // Server has no push keys → nothing a student could do; never block.
    try { await getVapidPublicKey(); } catch { return setStage("hidden"); }

    if (Notification.permission === "granted") {
      setStage(s => (s === "granted" ? s : "hidden"));
      // Keep this device linked to the account (login codes need it).
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await syncPushSubscription(sub);
        else await requestAndSubscribeToPush();
      } catch (e) {
        console.warn("[notification-gate] background subscribe failed; retrying next launch", e);
      }
      return;
    }
    setStage(Notification.permission === "denied" ? "denied" : "ask");
  }, [pathname]);

  useEffect(() => {
    void evaluate();
    // Coming back from browser/phone settings must re-check by itself.
    const onVisible = () => { if (document.visibilityState === "visible") void evaluate(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [evaluate]);

  async function enable() {
    setStage("busy");
    setErrorText("");
    try {
      const { granted } = await requestAndSubscribeToPush();
      if (granted) {
        setStage("granted");
        setTimeout(() => setStage("hidden"), 1200);
      } else {
        setStage(Notification.permission === "denied" ? "denied" : "ask");
      }
    } catch (e) {
      console.error("[notification-gate] enable failed", e);
      if (Notification.permission === "granted") {
        setStage("hidden"); // permission given; saving failed — retried next launch
        return;
      }
      setErrorText(e instanceof Error ? e.message : "Could not turn on notifications. Please try again.");
      setStage("ask");
    }
  }

  if (stage === "hidden") return null;

  const icon = (Icon: typeof Bell, tone: "plain" | "ok" = "plain") => (
    <div style={{ width: 56, height: 56, borderRadius: "50%", background: tone === "ok" ? ui.successSoft : ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
      <Icon size={24} strokeWidth={1.8} color={tone === "ok" ? ui.success : ui.textPrimary} />
    </div>
  );
  const primary: CSSProperties = { width: "100%", border: 0, borderRadius: ui.radius.button, padding: "14px 16px", background: ui.textPrimary, color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" };
  const steps: CSSProperties = { textAlign: "left", margin: "0 0 18px", padding: "12px 14px 12px 30px", background: ui.canvas, borderRadius: ui.radius.button, color: ui.textSecondary, fontSize: 13.5, lineHeight: 1.6 };

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, zIndex: 110, background: ui.surface, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 380, width: "100%", textAlign: "center" }}>
        {stage === "granted" ? (
          <>
            {icon(CheckCircle2, "ok")}
            <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 600, color: ui.textPrimary }}>You&apos;re all set</h2>
            <p style={{ margin: 0, color: ui.textSecondary, fontSize: 14 }}>Updates and login codes will now arrive on this phone.</p>
          </>
        ) : stage === "denied" ? (
          <>
            {icon(BellOff)}
            <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: ui.textPrimary }}>Notifications are turned off</h2>
            <p style={{ margin: "0 0 14px", color: ui.textSecondary, fontSize: 14, lineHeight: 1.5 }}>
              The Student App needs notifications — your login codes, payment approvals and case updates arrive this way. Turn them back on:
            </p>
            <ol style={steps}>
              {isStandalone() ? (
                <>
                  <li>Press and hold the Student App icon on your home screen</li>
                  <li>Tap <b>App info</b> (ⓘ) → <b>Notifications</b></li>
                  <li>Turn notifications <b>on</b>, then come back here</li>
                </>
              ) : (
                <>
                  <li>Tap the icon left of the website address (🔒 or ⓘ)</li>
                  <li>Tap <b>Permissions</b> → <b>Notifications</b></li>
                  <li>Choose <b>Allow</b>, then come back here</li>
                </>
              )}
            </ol>
            <button type="button" onClick={() => void evaluate()} style={primary}>I&apos;ve turned it on</button>
          </>
        ) : stage === "install" ? (
          <>
            {icon(Smartphone)}
            <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: ui.textPrimary }}>Install the Student App</h2>
            <p style={{ margin: "0 0 14px", color: ui.textSecondary, fontSize: 14, lineHeight: 1.5 }}>
              On iPhone, notifications only work in the installed app.
            </p>
            <ol style={steps}>
              <li>Tap the <b>Share</b> button (□↑) at the bottom of Safari</li>
              <li>Tap <b>Add to Home Screen</b> → <b>Add</b></li>
              <li>Open <b>Student App</b> from your home screen and turn on notifications</li>
            </ol>
          </>
        ) : stage === "old-device" ? (
          <>
            {icon(BellOff)}
            <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: ui.textPrimary }}>This phone can&apos;t show app notifications</h2>
            <p style={{ margin: "0 0 18px", color: ui.textSecondary, fontSize: 14, lineHeight: 1.5 }}>
              Your phone&apos;s software is too old for app notifications (iPhone needs iOS 16.4 or newer). Login codes will come on WhatsApp or by text instead, and your updates wait for you inside the app. Updating your phone turns this on.
            </p>
            {/* (14 Nov 2026): a browser that can't do push is not a dead
            end — the student continues and codes arrive on WhatsApp,
            exactly as the copy above promises. */}
            <button type="button" onClick={() => { window.localStorage.setItem(NO_PUSH_ACK_KEY, "1"); setStage("hidden"); }} style={primary}>Continue</button>
          </>
        ) : (
          <>
            {icon(Bell)}
            <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600, color: ui.textPrimary }}>Turn on notifications to continue</h2>
            <p style={{ margin: "0 0 18px", color: ui.textSecondary, fontSize: 14, lineHeight: 1.5 }}>
              The Student App sends your login codes, payment approvals, court case updates and announcements as notifications. It can&apos;t be used without them.
            </p>
            {errorText && <p style={{ margin: "0 0 12px", color: ui.warning, fontSize: 13 }}>{errorText}</p>}
            <button type="button" disabled={stage === "busy"} onClick={enable} style={{ ...primary, opacity: stage === "busy" ? 0.6 : 1 }}>
              {stage === "busy" ? "Turning on…" : "Turn on notifications"}
            </button>
            <p style={{ margin: "12px 0 0", color: ui.textTertiary, fontSize: 12.5 }}>When your phone asks, tap <b>Allow</b>.</p>
          </>
        )}
      </div>
    </div>
  );
}
