"use client";

import { usePathname } from "next/navigation";
import PwaBootstrap from "@/components/PwaBootstrap";

function hasFreshInstallHandoff(): boolean {
  if (typeof window === "undefined") return false;
  const token = window.localStorage.getItem("sp_pending_registration_token");
  const marker = window.localStorage.getItem("sp_pwa_installed");
  const installedAt = Number(window.localStorage.getItem("sp_pwa_installed_at"));
  return Boolean(token) && marker === "1" && Number.isFinite(installedAt) &&
    Date.now() - installedAt >= 0 && Date.now() - installedAt <= 10 * 60 * 1000;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    Boolean((window.navigator as any).standalone);
}

/**
 * /install has its own installation/handoff UI. PwaBootstrap must not mount
 * there because its global install gate can race the handoff page and paint
 * the old "Student App required" overlay over the registration flow.
 *
 * The same exclusion is needed for the brief browser handoff immediately
 * after appinstalled: PwaBootstrap used to clear the fresh install marker
 * before /install could display the post-install handoff. This component
 * decides synchronously, before the child mounts, so that marker cannot be
 * lost in that race.
 */
export default function PwaBootstrapMount() {
  const pathname = usePathname();

  if (pathname === "/install" || pathname.startsWith("/install/")) return null;

  if (!isStandalone() && hasFreshInstallHandoff()) return null;

  return <PwaBootstrap />;
}
