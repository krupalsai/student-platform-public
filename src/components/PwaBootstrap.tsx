"use client";

import { useEffect } from "react";
import { initPwaRecovery } from "@/lib/pwa-recovery";

/**
 * Global PWA bootstrap.
 *
 * Push notifications are never gated — this component only registers the
 * service worker, and permission prompts must happen from an explicit user
 * action, never during app bootstrap. Installation itself is NOT optional
 * for a WhatsApp-driven registration, though: /install (InstallStudentAppBody)
 * is a hard gate — "installation is the only action available from the
 * public hand-off page" per its own file comment. This component's earlier
 * "browser-first, never blocked by an install gate" claim described intent
 * that /install's actual behavior no longer matches; kept here corrected so
 * a future read of this file isn't misled about what actually gates
 * registration today.
 *
 * Keep the service worker registered globally so Web Push and the installed PWA
 * work when a student enables them later.
 */
export default function PwaBootstrap() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Self-cleaning cache (src/lib/pwa-recovery.ts): chunk-load failures
    // clean up and reload once, waiting workers activate promptly, and the
    // worker is checked for updates on launch / focus / visibility. It is
    // installed even if registration below fails — recovery does not need
    // a registration to work.
    const cleanupRecovery = initPwaRecovery();
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch(err => console.error("[pwa] service worker registration failed", err));
    return cleanupRecovery;
  }, []);

  return null;
}
