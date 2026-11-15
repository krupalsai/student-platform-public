"use client";

import { useEffect } from "react";

/**
 * Keeps profiles.last_active_at fresh for the signed-in admin. Renders
 * nothing.
 *
 * This was AdminPresence, which also drew a row of coloured dots and admin
 * names across the top of every admin page. That bar was removed on request.
 * The heartbeat is deliberately kept: Activity Logs (/admin/audit) derives
 * "Online now" and "Last seen …" per admin from last_active_at, so dropping
 * the component wholesale would have left that page showing everyone as
 * never-logged-in without anything visibly breaking.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;

export default function AdminHeartbeat() {
  useEffect(() => {
    const beat = () =>
      fetch("/api/admin/presence", {
        method: "POST",
        headers: { Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` },
      }).catch(() => {});

    beat();
    const interval = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return null;
}
