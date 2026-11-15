"use client";

import { useEffect, useRef, useState } from "react";
import {
  isIosDevice, isIosSafari, isAndroidInAppBrowser, isFirefox, isSamsungInternet, escapeToChrome,
  getInstallBlockedBrowserLabel,
} from "@/lib/pwa-detect";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type InstallPath = "installed" | "browser" | "chrome-escape" | "ios-steps";

// How long a tap waits for beforeinstallprompt to arrive before honestly
// saying install isn't available. The prompt is a best-effort Chromium
// event: it can arrive late on a slow connection, and it can never arrive
// at all (already dismissed, engagement heuristic not met, automated
// Chrome). The wait runs ONLY after the student taps Install — there is
// NO timer on mount any more. The 2-second mount timer this replaces hid
// the Install button within seconds on every load, before anyone could
// tap it, even when the prompt would have arrived a moment later
// (14 Nov 2026, real browser test: button replaced by the fallback on
// 4+ fresh loads, no prompt ever shown). The button stays until the
// student taps it, and stays available to retry after a failed tap.
const TAP_WAIT_MS = 10_000;

/**
 * ONE button, one step (14 Nov 2026): non-technical students must never
 * hunt through Chrome's menu. The page shows one medium, normal-sized
 * "Install App" button, centred — not big, not oversized (Krupal's
 * correction, 14 Nov); tapping it fires the browser's own install prompt
 * directly. No menu steps, no "Add to Home screen" explanation, no
 * technical words.
 *
 * Device coverage is device-agnostic by design — installability is
 * Chrome's rules, the same on every Android: true square PNG icons
 * (192 + 512, served by /api/app-icon), a correct manifest, a working
 * service worker, and beforeinstallprompt capture. That is what makes
 * the prompt exist on Vivo, Samsung, Xiaomi/Redmi, Oppo, Realme,
 * OnePlus, Pixel, Motorola, Infinix/Tecno and generic Android Chrome
 * alike — no per-model code anywhere.
 *
 * Phones whose DEFAULT browser cannot install at all — Vivo Browser,
 * Mi Browser, HeyTap Browser (Oppo/Realme), and in-app browsers
 * (WhatsApp, Instagram, Facebook) — get ONE plain line naming what they
 * are in, a medium "Open in Chrome" button, and "Continue in browser".
 * No menu steps, ever.
 *
 * iOS has no beforeinstallprompt at all, so the same medium button shows
 * the one simplest iOS path in plain words (Share > Add to Home Screen).
 * That is the only Apple path; there is nothing else to tap.
 *
 * If install truly cannot happen on that phone, the page never dead-ends:
 * one "Continue in browser" button takes the student to registration in
 * the browser instead. Which path was used is logged (localStorage +
 * /api/install-event) so the team can see install vs browser numbers.
 */
function logInstallPath(path: InstallPath): void {
  try {
    localStorage.setItem("sp_install_path", path);
  } catch {
    /* ignore */
  }
  try {
    void fetch("/api/install-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ua: navigator.userAgent.slice(0, 220) }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* logging must never break the install flow */
  }
}

// Medium, normal-sized, centred — Krupal's correction, 14 Nov 2026:
// NOT a big/oversized button. One tap installs.
const buttonClass =
  "mx-auto block w-auto min-w-[200px] rounded-xl px-8 py-3 text-base font-semibold text-white bg-[#111827] shadow active:scale-[0.98] transition";

const secondaryButtonClass =
  "mx-auto block w-auto min-w-[200px] rounded-xl px-8 py-3 text-base font-semibold border";

export default function InstallPwaButton({
  appName = "Student App",
  autoPrompt = false,
  onFallbackReady,
  onJustInstalled,
  onContinueInBrowser,
}: {
  appName?: string;
  /**
   * Auto-fire the native install dialog the instant beforeinstallprompt is
   * available, no button tap required first. Only safe when landing on this
   * component IS the user's install intent (a dedicated /install page) — NOT
   * when it's a secondary widget next to other content (e.g. the register
   * page's sidebar), where popping a native OS dialog unprompted would
   * interrupt whatever the visitor is actually doing.
   */
  autoPrompt?: boolean;
  /**
   * Fires once a real install attempt has actually concluded — installed,
   * declined, or no automatic path exists on this browser at all (iOS,
   * Firefox, an in-app browser, a makers' default browser, or Chrome
   * never offering the prompt after a real tap). Lets a parent page reveal
   * a "continue without installing" fallback only after genuinely trying,
   * not as a shortcut around it. Never fires while still installed — that
   * has its own success state. Never fires on mount: until the student
   * taps, nothing has been tried.
   */
  onFallbackReady?: () => void;
  /**
   * Fires the moment a REAL install (not "already was installed" on mount)
   * is confirmed — the accepted native prompt, or the browser's own
   * `appinstalled` event. Also persists `sp_pwa_installed`/
   * `sp_pwa_installed_at` to localStorage, which InstallStudentAppBody reads
   * to show its "open Student App from your home screen" handoff screen.
   */
  onJustInstalled?: () => void;
  /**
   * The one fallback when install cannot happen on this phone: take the
   * student to registration in the browser instead. The parent knows
   * where (registration token / next path); when absent, no
   * "Continue in browser" button is shown.
   */
  onContinueInBrowser?: () => void;
}) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  // A ref, not state: this is purely a guard against double-firing the
  // auto-install attempt, not something that should ever cause the effect
  // below to re-run.
  const autoAttemptedRef = useRef(false);
  // The student tapped Install before the prompt event arrived: fire it
  // the moment it lands instead of leaving them on a dead button.
  const tapPendingRef = useRef(false);
  // The tap's wait for the prompt, so it can be cancelled the moment the
  // prompt actually arrives — a late prompt must revive the button, not
  // lose the race to its own timeout.
  const tapTimeoutRef = useRef<number | null>(null);
  const [ios, setIos] = useState(false);
  const [iosSafari, setIosSafari] = useState(false);
  // Plain name of a browser that cannot install this app at all
  // ("Vivo Browser", "Mi Browser", "HeyTap Browser", "Instagram",
  // "Facebook", "another app"), or null when the current browser can.
  const [blockedBrowser, setBlockedBrowser] = useState<string | null>(null);
  const [firefox, setFirefox] = useState(false);
  const [samsung, setSamsung] = useState(false);
  // Set ONLY after a real tap waited the full TAP_WAIT_MS with no prompt,
  // after prompt() threw, or after the student declined the prompt.
  // Never set on mount, never on a timer the student didn't start.
  const [promptUnavailable, setPromptUnavailable] = useState(false);
  const [showIosSteps, setShowIosSteps] = useState(false);
  const [prompting, setPrompting] = useState(false);

  const markInstalled = () => {
    setInstalled(true);
    logInstallPath("installed");
    try {
      localStorage.setItem("sp_pwa_installed", "1");
      localStorage.setItem("sp_pwa_installed_at", String(Date.now()));
    } catch {
      // Safari private mode etc. — the fresh-install handoff screen just
      // won't show; the install itself already succeeded regardless.
    }
    onJustInstalled?.();
  };

  async function firePrompt(event: BeforeInstallPromptEvent): Promise<void> {
    setPrompting(true);
    try {
      await event.prompt();
      const result = await event.userChoice;
      if (result.outcome === "accepted") {
        markInstalled();
      } else {
        // Declined: the one next step is continuing in the browser, not
        // another prompt. The Install button stays above it to retry.
        setPromptUnavailable(true);
      }
    } catch {
      setPromptUnavailable(true);
    } finally {
      setPrompting(false);
      setDeferredPrompt(null);
    }
  }

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) setInstalled(true);

    setIos(isIosDevice());
    setIosSafari(isIosSafari());
    // One label covers both cases: an in-app WebView (WhatsApp, Instagram,
    // Facebook) and a maker's default browser (Vivo / Mi / HeyTap), which
    // cannot install either. Samsung Internet is NOT blocked — it offers
    // a real install prompt — so it stays on the main Install path.
    setBlockedBrowser(isAndroidInAppBrowser() ? (getInstallBlockedBrowserLabel() ?? "another app") : getInstallBlockedBrowserLabel());
    setFirefox(isFirefox());
    setSamsung(isSamsungInternet());

    const params = new URLSearchParams(window.location.search);
    const autoInstall = autoPrompt || params.get("install") === "1";

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      const installEvent = event as BeforeInstallPromptEvent;
      // A late prompt revives the button even if a failed tap already
      // showed the fallback — the fallback must never win over a prompt
      // that did arrive.
      if (tapTimeoutRef.current !== null) {
        window.clearTimeout(tapTimeoutRef.current);
        tapTimeoutRef.current = null;
      }
      setPromptUnavailable(false);
      setDeferredPrompt(installEvent);

      if (tapPendingRef.current) {
        tapPendingRef.current = false;
        void firePrompt(installEvent);
        return;
      }
      if (autoInstall && !autoAttemptedRef.current) {
        autoAttemptedRef.current = true;
        void firePrompt(installEvent);
      }
    };

    const onInstalled = () => {
      markInstalled();
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // No mount timer: beforeinstallprompt can legitimately never arrive
    // (already dismissed earlier, engagement heuristic not yet met, or a
    // browser that never fires it at all), and waiting with the Install
    // button visible costs the student nothing. The fallback appears
    // only after a real tap fails — see handleInstallTap.
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      if (tapTimeoutRef.current !== null) {
        window.clearTimeout(tapTimeoutRef.current);
        tapTimeoutRef.current = null;
      }
    };
    // Deliberately empty deps: this must run exactly once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Ready" = a real attempt actually concluded: installed, declined,
  // a tap waited the full wait with no prompt, or no automatic install
  // path exists on this browser at all.
  useEffect(() => {
    if (installed || blockedBrowser !== null || ios || firefox || promptUnavailable) {
      onFallbackReady?.();
    }
    // onFallbackReady intentionally excluded — parents that pass an inline
    // function shouldn't retrigger this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed, blockedBrowser, ios, firefox, promptUnavailable]);

  if (installed) return <p className="text-sm">✅ {appName} is installed.</p>;

  // Inside WhatsApp/Instagram/Facebook, or in a maker's default browser
  // (Vivo / Mi / HeyTap) — no install API exists there at all, in any
  // browser. One plain line naming what they are in, one tap re-opens
  // this exact page in real Chrome, where installing actually works.
  // No menu steps. "Continue in browser" is always there as the
  // no-Chrome path.
  if (blockedBrowser !== null) {
    return (
      <div className="space-y-3 text-center">
        <p className="text-sm">
          {blockedBrowser === "another app"
            ? "You opened this inside another app, which can't install apps."
            : `You opened this in ${blockedBrowser}, which can't install apps.`}
        </p>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            logInstallPath("chrome-escape");
            escapeToChrome();
          }}
        >
          Open in Chrome
        </button>
        {onContinueInBrowser && (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => {
              logInstallPath("browser");
              onContinueInBrowser();
            }}
          >
            Continue in browser
          </button>
        )}
      </div>
    );
  }

  // iOS has no install prompt at all. The same medium button starts the one
  // Apple path in plain words — Share, then Add to Home Screen. Nothing
  // else to figure out, and continuing in the browser is always there.
  if (ios) {
    if (showIosSteps) {
      return (
        <div className="space-y-3 text-center">
          <p className="text-base font-semibold">Install {appName} on your iPhone</p>
          <p className="text-sm leading-relaxed">
            Tap <strong>Share</strong> at the bottom of Safari, then tap{" "}
            <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
          </p>
          {!iosSafari && (
            <p className="text-sm opacity-80">
              Open this page in <strong>Safari</strong> first — iPhone does not install apps from Chrome.
            </p>
          )}
          {onContinueInBrowser && (
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                logInstallPath("browser");
                onContinueInBrowser();
              }}
            >
              Continue in browser
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="space-y-3 text-center">
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            logInstallPath("ios-steps");
            setShowIosSteps(true);
          }}
        >
          Install App
        </button>
        <p className="text-sm opacity-70">One tap — no menus, no settings.</p>
      </div>
    );
  }

  // The one medium button. Tapping fires the install prompt directly when it
  // is ready; when it is still arriving, the tap is remembered and the
  // prompt fires the moment it lands. Only after a real tap waits the
  // full TAP_WAIT_MS with no prompt do we say install isn't available —
  // and the button stays above that message to retry.
  const handleInstallTap = () => {
    if (deferredPrompt) {
      void firePrompt(deferredPrompt);
      return;
    }
    setPromptUnavailable(false);
    tapPendingRef.current = true;
    setPrompting(true);
    if (tapTimeoutRef.current !== null) {
      window.clearTimeout(tapTimeoutRef.current);
    }
    tapTimeoutRef.current = window.setTimeout(() => {
      tapTimeoutRef.current = null;
      if (tapPendingRef.current) {
        tapPendingRef.current = false;
        setPrompting(false);
        setPromptUnavailable(true);
      }
    }, TAP_WAIT_MS);
  };

  // Chromium-based (Chrome, Samsung Internet, Edge) but the automatic
  // prompt never showed up after a real tap — or the student declined it,
  // or this is Firefox, which never offers it. One simple next step, never
  // a dead end and never menu steps: continue in the browser. The Install
  // button stays on top (except on Firefox, where no prompt can ever
  // exist) so the student can retry instead of starting over.
  if (promptUnavailable || firefox) {
    return (
      <div className="space-y-3 text-center">
        {!firefox && (
          <button type="button" className={buttonClass} onClick={handleInstallTap} disabled={prompting}>
            {prompting ? "Getting the installer ready…" : "Install App"}
          </button>
        )}
        <p className="text-base font-semibold">Install isn&apos;t available on this phone right now.</p>
        <p className="text-sm opacity-80">You can still register — no need to install first.</p>
        {onContinueInBrowser ? (
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              logInstallPath("browser");
              onContinueInBrowser();
            }}
          >
            Continue in browser
          </button>
        ) : (
          <button type="button" className={buttonClass} onClick={() => window.location.reload()}>
            Try installing again
          </button>
        )}
        {onContinueInBrowser && (
          <button
            type="button"
            className="w-full text-sm opacity-70 underline"
            onClick={() => window.location.reload()}
          >
            Try installing again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-center">
      <button type="button" className={buttonClass} onClick={handleInstallTap} disabled={prompting}>
        {prompting ? "Getting the installer ready…" : "Install App"}
      </button>
      <p className="text-sm opacity-70">One tap — no menus, no settings.</p>
      {samsung && <p className="text-xs opacity-60">Works on Samsung Internet too.</p>}
    </div>
  );
}
