/**
 * PWA self-cleaning cache.
 *
 * The failure this fixes: a student PWA installed on an old build kept
 * serving that build's JavaScript, whose chunks no longer exist on the
 * server (every deploy prunes old build assets). The app then failed with
 * "Loading chunk ... failed" / "Script error." and blinked on every
 * reload, and the only escape was manual — close fully, open in Chrome,
 * clear site data, uninstall and reinstall.
 *
 * The service worker itself keeps no copy of the app (public/sw.js, v8+),
 * so the stale bits are the browser's cached page/chunks plus an old
 * worker registration. This module makes the app clean those up itself:
 *
 *   - a chunk load fails  -> unregister workers, delete Cache Storage,
 *     reload once (loop-guarded);
 *   - a new worker is waiting -> activate it now and reload once onto the
 *     new build, instead of waiting for every tab to close;
 *   - launch / focus / visibility / interval -> ask the worker if a new
 *     /sw.js exists, so updates propagate within minutes, not a day.
 *
 * HARD LIMITS, by design: the AUTOMATIC recovery touches Cache Storage
 * and service-worker registrations ONLY. It never clears localStorage
 * (except its own guard key), sessionStorage (except its own guard key),
 * IndexedDB, or cookies — login sessions live there (localStorage
 * sp_token, sp_session cookie). It never touches payments, auth, OTP,
 * fees, or push.
 *
 * ONE deliberate exception (14 Nov 2026, the Vivo stuck-launch gap found
 * 10 Nov): `recoverStuckSession` below is NEVER automatic — it only runs
 * when the student taps "Fix my app" (the /fix page, the launch-cover
 * escape, or the diagnose panel). A stuck session check leaves the app
 * on "Loading…" forever, and no cache-only clean can fix that: the stale
 * login is the problem. The tap clears ONLY this phone's saved login
 * (sp_token / sp_role / session storage) plus the same worker/cache
 * clean, then opens a fresh OTP login. Nothing on the server is touched
 * — the profile, batch and payments are untouched; the student just
 * signs in again with a code.
 *
 * Pure decision logic (isChunkLoadFailure) has no I/O and is unit-tested
 * in tests/pwa-recovery.test.ts. Nothing in this file runs at import time,
 * so importing it under node --test is safe.
 */

const CHUNK_MESSAGE_RES = [
  /loading chunk/i,
  /chunkloaderror/i,
  /failed to fetch dynamically imported module/i,
  /loading css chunk/i,
  /importing a module script failed/i,
  /failed to load (?:module )?script/i,
];

const CHUNK_URL_RE = /\/_next\/static\/(?:chunks|css)\//;

/**
 * Pure: is this error a stale-build chunk failure, rather than any other
 * error? Scoped narrowly on purpose — a general error must never trigger
 * a reload, or a real bug turns into a reload loop.
 *
 * "Script error." alone is opaque (cross-origin, no detail), so it only
 * counts when the failing file is one of our own Next chunks.
 */
export function isChunkLoadFailure(message: string, filename?: string | null): boolean {
  const msg = (message ?? "").trim();
  if (/^\s*script error\.?\s*$/i.test(msg)) {
    return !!filename && CHUNK_URL_RE.test(filename);
  }
  if (CHUNK_MESSAGE_RES.some((re) => re.test(msg))) return true;
  // A resource error naming one of our chunks (e.g. a failed <script> tag).
  if (filename && CHUNK_URL_RE.test(filename) && /failed|error|load/i.test(msg)) return true;
  return false;
}

// ── Loop guard (sessionStorage, own key only) ───────────────────────────

const RECOVERY_KEY = "sp_pwa_recovery_at";
const RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;

function readGuard(): number | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const last = Number(sessionStorage.getItem(RECOVERY_KEY));
    return Number.isFinite(last) ? last : null;
  } catch {
    return null;
  }
}

function writeGuard(now: number): void {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(RECOVERY_KEY, String(now));
  } catch {
    /* storage blocked — the cooldown just doesn't apply */
  }
}

/**
 * True when no auto-recovery has run in the last 30 minutes. One recovery
 * per period, never two reloads without a successful load in between —
 * a page that still fails after a recovery shows its normal error (and
 * ClientErrorReporter reports it) instead of looping.
 */
export function canAutoRecover(now = Date.now()): boolean {
  const last = readGuard();
  if (last === null) return true;
  const age = now - last;
  return age < 0 || age >= RECOVERY_COOLDOWN_MS;
}

/** Claim the one recovery slot for this period. False when already used. */
function claimRecoverySlot(now = Date.now()): boolean {
  if (!canAutoRecover(now)) return false;
  writeGuard(now);
  return true;
}

// ── "Updating app…" state ───────────────────────────────────────────────

function showUpdatingOverlay(title = "Updating app…", subtitle = "Cleaning up the old version, one moment."): void {
  try {
    if (typeof document === "undefined") return;
    if (document.getElementById("sp-pwa-updating")) return;
    const div = document.createElement("div");
    div.id = "sp-pwa-updating";
    div.setAttribute("role", "status");
    div.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#f2f2f7;color:#1c1c1e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;text-align:center";
    div.innerHTML =
      `<div><div style='font-size:20px;font-weight:600;margin-bottom:8px'>${title}</div>` +
      `<div style='font-size:14px;color:#6e6e73'>${subtitle}</div></div>`;
    document.body.appendChild(div);
  } catch {
    /* the overlay must never block the recovery itself */
  }
}

// ── Recovery ────────────────────────────────────────────────────────────

/**
 * Race a promise against a clock. Resolves with the promise's value, or
 * with undefined when the clock wins. Used by the recovery paths below:
 * service-worker and Cache Storage calls can stall indefinitely on a
 * wedged worker, and a recovery that waits on them is itself the stuck
 * screen the student is trying to escape (14 Nov 2026: /fix sat on
 * "Fixing the app…" for 5 minutes because getRegistrations() never
 * settled, so the redirect to /login never ran).
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Best-effort worker/cache clean. Never awaited without a timeout — on a
 * wedged worker these calls can stall indefinitely.
 */
async function cleanWorkersAndCaches(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
    }
  } catch {
    /* keep going */
  }
  try {
    if (typeof window !== "undefined" && "caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
    }
  } catch {
    /* ignore */
  }
}

/**
 * Self-clean: drop every service-worker registration and every Cache
 * Storage cache, then reload once onto a fresh page. The reload
 * revalidates the document (no-cache HTML), so the fresh page registers
 * the current worker. Guarded: a second failure within 30 minutes does
 * nothing instead of looping.
 */
export async function selfCleanAndReload(): Promise<void> {
  if (!claimRecoverySlot()) return;
  showUpdatingOverlay();
  // Same backstop as recoverStuckSession: the reload must happen even if
  // the worker/cache cleanup stalls on a wedged worker.
  let reloaded = false;
  const go = () => {
    if (reloaded) return;
    reloaded = true;
    try {
      location.reload();
    } catch {
      /* ignore */
    }
  };
  const backstop = window.setTimeout(go, 3000);
  try {
    await withTimeout(cleanWorkersAndCaches(), 2500);
  } catch {
    /* the backstop below reloads regardless */
  }
  window.clearTimeout(backstop);
  go();
}

/** Reload onto a newly activated worker — no cleaning (the new worker
 *  already deleted old caches on activate). Same one-per-period guard. */
function reloadForUpdate(): void {
  if (!claimRecoverySlot()) return;
  showUpdatingOverlay();
  try {
    location.reload();
  } catch {
    /* ignore */
  }
}

/**
 * Explicit stuck-session reset (user tap only — NEVER called automatically).
 *
 * The Vivo stuck-launch case (14 Nov 2026): the app opens, the launch
 * cover shows "Loading Student Platform…", the session check never
 * resolves, and the student is stuck — no menu, no screen, nothing to
 * tap. The cache-only clean cannot help because the stale login session
 * is the stuck part. This clears this phone's saved login (sp_token,
 * sp_role, the load trail, all session storage) plus the same worker /
 * cache clean, then opens a fresh login where the student signs in again
 * with a 6-digit code. Server data is untouched: profile, batch and
 * payments all stay exactly as they were.
 */
export async function recoverStuckSession(): Promise<void> {
  showUpdatingOverlay("Fixing the app…", "Clearing the stuck login, one moment.");
  // 1. The actual fix — synchronous, cannot hang: drop this phone's login.
  try {
    localStorage.removeItem("sp_token");
    localStorage.removeItem("sp_role");
    localStorage.removeItem("sp_loads");
    localStorage.removeItem("sp_trail");
  } catch {
    /* storage blocked — continue with the rest */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  // 2. The navigation MUST happen no matter what the cleanup below does.
  // A 3s backstop navigates even if every cleanup promise stalls; the
  // cleanup itself is best-effort and runs in parallel.
  let navigated = false;
  const go = () => {
    if (navigated) return;
    navigated = true;
    try {
      window.location.replace("/login");
    } catch {
      try {
        location.reload();
      } catch {
        /* ignore */
      }
    }
  };
  const backstop = window.setTimeout(go, 3000);
  try {
    await withTimeout(cleanWorkersAndCaches(), 2500);
  } catch {
    /* the backstop below navigates regardless */
  }
  window.clearTimeout(backstop);
  go();
}

// ── Update checks ───────────────────────────────────────────────────────

async function checkForSwUpdate(): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
  } catch {
    /* offline or no registration — the next check retries */
  }
}

function eventLooksLikeChunkFailure(e: Event): boolean {
  const msg = (e as ErrorEvent).message ?? "";
  const filename = (e as ErrorEvent).filename ?? "";
  if (msg || filename) return isChunkLoadFailure(msg, filename || undefined);
  // Resource-element error (capture phase): no message, the target is the
  // failed <script>/<link> tag itself.
  const t = e.target as (HTMLScriptElement | HTMLLinkElement | null);
  if (t && typeof t.tagName === "string") {
    const url = (t as HTMLScriptElement).src || (t as HTMLLinkElement).href || "";
    if (CHUNK_URL_RE.test(url)) return true;
  }
  return false;
}

const UPDATE_INTERVAL_MS = 5 * 60 * 1000;

let started = false;
let destroyFns: Array<() => void> = [];
// A Set (not WeakSet): destroy() must be able to forget a registration, or
// a StrictMode remount would never re-bind its updatefound listener.
let boundRegistrations = new Set<ServiceWorkerRegistration>();

function bindRegistration(reg: ServiceWorkerRegistration): void {
  if (boundRegistrations.has(reg)) return;
  boundRegistrations.add(reg);
  const onUpdateFound = () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      // New worker installed while this page is controlled: activate it now
      // instead of waiting for every tab to close.
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        try {
          reg.waiting?.postMessage({ type: "SKIP_WAITING" });
        } catch {
          /* next navigation picks it up anyway */
        }
      }
    });
  };
  reg.addEventListener("updatefound", onUpdateFound);
  destroyFns.push(() => reg.removeEventListener("updatefound", onUpdateFound));
}

/**
 * Start the self-cleaning behaviour. Idempotent — calling it again (e.g.
 * React StrictMode double-mount) only re-binds a new registration.
 * Returns a cleanup that removes every listener and timer.
 */
export function initPwaRecovery(): () => void {
  if (typeof window === "undefined") return () => {};
  if (!started) {
    started = true;
    const onError = (e: ErrorEvent) => {
      try {
        if (eventLooksLikeChunkFailure(e)) void selfCleanAndReload();
      } catch {
        /* the recovery must never throw into the app */
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      try {
        const r = e.reason;
        const msg = r instanceof Error ? r.message : String(r ?? "");
        if (isChunkLoadFailure(msg)) void selfCleanAndReload();
      } catch {
        /* ignore */
      }
    };
    const onControllerChange = () => reloadForUpdate();
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkForSwUpdate();
    };
    const onFocus = () => void checkForSwUpdate();
    // Capture phase: resource <script>/<link> errors don't bubble, so a
    // plain window error listener never sees a failed chunk tag.
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void checkForSwUpdate(), UPDATE_INTERVAL_MS);
    destroyFns = [
      () => window.removeEventListener("error", onError, true),
      () => window.removeEventListener("unhandledrejection", onRejection),
      () => navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange),
      () => document.removeEventListener("visibilitychange", onVisible),
      () => window.removeEventListener("focus", onFocus),
      () => window.clearInterval(timer),
    ];
    // Launch check, plus bind the current registration for updatefound.
    void checkForSwUpdate();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready
        .then((reg) => bindRegistration(reg))
        .catch(() => {});
    }
  }
  // A registration may arrive after init (register() resolves later) —
  // bind it too so its updatefound is watched.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => {
        if (reg) bindRegistration(reg);
      })
      .catch(() => {});
  }
  return () => {
    destroyFns.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
    destroyFns = [];
    boundRegistrations.clear();
    started = false;
  };
}
