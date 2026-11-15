"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bell, BellOff, CheckCheck } from "lucide-react";
import { ui } from "@/lib/student-ui";

type Notification = {
  id: string;
  type: string;
  message: string;
  sent_at: string;
  read_at: string | null;
};

function sessionHeaders(): HeadersInit {
  const token = localStorage.getItem("sp_token")?.trim() ?? "";
  return token
    ? { Authorization: `Bearer ${token}`, "x-session-token": token }
    : {};
}

/** Same markdown-lite as the support chat: escape HTML, **bold**, newlines. */
function renderRich(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br/>");
}

function titleFor(type: string): string {
  const map: Record<string, string> = {
    payment_reminder: "Payment reminder",
    payment_nudge: "Payment reminder",
    registration: "Registration",
    app_login_link: "Student App", // old rows, before the link was removed 9 Nov 2026
    app_ready: "Student App",
    announcement: "Announcement",
    group_message: "Batch discussion",
    voice_call: "Voice call",
  };
  if (map[type]) return map[type];
  if (type.startsWith("payment_")) return "Payment update";
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications", { headers: sessionHeaders() });
        if (!res.ok) throw new Error("Could not load notifications.");
        const json = await res.json();
        if (cancelled) return;
        setItems(json.notifications ?? []);
        // Mark everything read once the inbox has been seen.
        await fetch("/api/notifications", {
          method: "POST",
          headers: { ...sessionHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ all: true }),
        }).catch(() => {});
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{ minHeight: "100dvh", background: ui.canvas }} className="flex flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${ui.border}`, background: ui.surface }}>
        <Link href="/dashboard" aria-label="Back" style={{ color: ui.textSecondary }}>
          <ArrowLeft size={20} strokeWidth={1.8} />
        </Link>
        <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: ui.accent, color: "#fff" }}>
          <Bell size={17} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold" style={{ color: ui.textPrimary }}>Notifications</h1>
          <p className="text-[11px]" style={{ color: ui.textSecondary }}>Updates about your payments, batch and account</p>
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 px-3 py-4 sm:px-6">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-sm" style={{ color: ui.textTertiary }}>Loading…</div>
        ) : error ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm font-semibold" style={{ color: ui.danger }}>{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full" style={{ background: ui.surface, border: `1px solid ${ui.border}` }}>
              <BellOff size={22} strokeWidth={1.6} style={{ color: ui.textTertiary }} />
            </div>
            <p className="text-sm font-semibold" style={{ color: ui.textPrimary }}>You&apos;re all caught up</p>
            <p className="max-w-xs text-xs" style={{ color: ui.textSecondary }}>
              Payment updates, reminders and announcements will appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl" style={{ background: ui.surface, border: `1px solid ${ui.border}` }}>
            {items.map((n, i) => (
              <div
                key={n.id}
                className="flex gap-3 px-4 py-3.5"
                style={{
                  borderBottom: i < items.length - 1 ? `1px solid ${ui.border}` : "none",
                  background: n.read_at ? "transparent" : ui.accentSoft ?? "transparent",
                }}
              >
                {!n.read_at && (
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: ui.accent }} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[13px] font-semibold" style={{ color: ui.textPrimary }}>{titleFor(n.type)}</p>
                    <span className="shrink-0 text-[11px]" style={{ color: ui.textSecondary }}>{timeAgo(n.sent_at)}</span>
                  </div>
                  <div
                    className="mt-0.5 text-[13px] leading-relaxed"
                    style={{ color: ui.textSecondary }}
                    dangerouslySetInnerHTML={{ __html: renderRich(n.message) }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {items.length > 0 && (
          <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px]" style={{ color: ui.textTertiary }}>
            <CheckCheck size={13} /> Everything above has been marked as read
          </p>
        )}
      </div>
    </main>
  );
}
