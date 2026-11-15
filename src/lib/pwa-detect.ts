/**
 * Browser/environment detection for PWA install flows. Shared by
 * InstallPwaButton (the /admin/install and /install pages) and
 * PwaBootstrap (the floating install prompt shown app-wide), so the two
 * don't drift into handling the same browsers differently.
 *
 * Why this exists: `beforeinstallprompt` is a Chromium-only, best-effort
 * event. It never fires on iOS Safari, never on Firefox (any platform),
 * and unreliably-to-never inside an app's in-app browser (WhatsApp,
 * Instagram, Facebook) — those WebViews are owned by the containing app,
 * not a real installable browser. Code that only waits for the event and
 * shows nothing else leaves those users stuck on "Preparing…" forever,
 * which is exactly the bug this was written to fix.
 */

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const webkit = /WebKit/i.test(ua);
  const chromeOrFirefox = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//i.test(ua);
  return isIosDevice() && webkit && !chromeOrFirefox;
}

/**
 * Android WebView-embedded in-app browsers (WhatsApp, Instagram, Facebook,
 * and most others). "; wv)" is the token Android's system WebView adds to
 * its own UA string that a real installed browser (Chrome, Firefox,
 * Samsung Internet) never sends — the standard, widely-used signal for
 * "this is someone else's app's browser, not a real one". WhatsApp itself
 * adds no distinctive marker of its own, so this generic check is what
 * actually catches it; Instagram/Facebook also stamp their own tokens,
 * checked as a belt-and-braces addition.
 */
export function isAndroidInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /; ?wv\)/i.test(ua) || /\bInstagram\b/i.test(ua) || /FBAN|FBAV/i.test(ua);
}

export function isFirefox(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Firefox\/|FxiOS\//i.test(navigator.userAgent);
}

export function isSamsungInternet(): boolean {
  if (typeof navigator === "undefined") return false;
  return /SamsungBrowser/i.test(navigator.userAgent);
}

/**
 * Phone-makers' own default browsers (14 Nov 2026 fix): Vivo Browser,
 * Mi Browser (Xiaomi / Redmi / Poco), and HeyTap Browser (Oppo / Realme).
 * These are the browsers that actually open when a student taps a link on
 * those phones, and none of them offers a real PWA install prompt —
 * Vivo / Mi / HeyTap only make a home-screen shortcut that opens a plain
 * browser tab, so a student waiting for "Install app" there waits forever.
 * They are Chromium-based, so they must NOT be mistaken for Chrome:
 * check them before assuming beforeinstallprompt can arrive.
 *
 * UA tokens (checked against the makers' published UA strings):
 * Vivo Browser sends "VivoBrowser/…", Mi Browser sends "MiuiBrowser/…",
 * HeyTap sends "HeyTapBrowser/…" (Oppo also sends "OppoBrowser/…",
 * Realme also sends "RealmeBrowser/…").
 */
export function isVivoBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /VivoBrowser/i.test(navigator.userAgent);
}

export function isMiBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /MiuiBrowser/i.test(navigator.userAgent);
}

export function isHeyTapBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  return /HeyTapBrowser|OppoBrowser|RealmeBrowser/i.test(navigator.userAgent);
}

/**
 * The one plain name for a browser that cannot install this app, or null
 * when the current browser is a real installable one (Chrome, Edge,
 * Samsung Internet) or iOS/Firefox (handled by their own branches).
 *
 * Order matters: named in-app browsers first (Instagram / Facebook stamp
 * their own tokens), then the makers' default browsers, then the generic
 * WebView token. WhatsApp stamps no token of its own, so a plain WebView
 * is reported as "another app" — the page says so in plain words rather
 * than guessing a name it cannot know.
 */
export function getInstallBlockedBrowserLabel(): string | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/\bInstagram\b/i.test(ua)) return "Instagram";
  if (/FBAN|FBAV/i.test(ua)) return "Facebook";
  if (isVivoBrowser()) return "Vivo Browser";
  if (isMiBrowser()) return "Mi Browser";
  if (isHeyTapBrowser()) return "HeyTap Browser";
  if (/; ?wv\)/i.test(ua)) return "another app";
  return null;
}

/**
 * Escapes an Android in-app browser into Chrome, carrying the current URL
 * along — with `install=1` added so InstallPwaButton auto-fires the native
 * install prompt the instant `beforeinstallprompt` is available in Chrome,
 * instead of landing the student on the page and making them tap Install a
 * second time. One tap in WhatsApp should be the whole flow.
 */
export function escapeToChrome(): void {
  if (typeof window === "undefined") return;
  const target = new URL(window.location.href);
  target.searchParams.set("install", "1");
  const rest = target.href.replace(/^https?:\/\//, "");
  // If Chrome is not installed, the intent cannot resolve — send the student
  // to install Chrome from the Play Store instead of failing silently.
  // (Krupal, 14 Nov 2026: "if not, ask them to install the Chrome.")
  const chromeStore =
    "https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.android.chrome";
  window.location.href =
    `intent://${rest}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${chromeStore};end`;
}
