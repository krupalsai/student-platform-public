"use client";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Home, Users, CreditCard, MessageCircle, User } from "lucide-react";
import { ui } from "@/lib/student-ui";

const ACCENT = ui.accent;

const TABS = [
  { id: "home",     label: "Home",     path: "/dashboard", Icon: Home },
  { id: "batch",    label: "Batch",    path: "/batch",     Icon: Users },
  { id: "payments", label: "Payments", path: "/payments",  Icon: CreditCard },
  { id: "messages", label: "Messages", path: "/messages",  Icon: MessageCircle },
  { id: "profile",  label: "Profile",  path: "/profile",   Icon: User },
] as const;

/**
 * The 5 always-visible student tabs. If an admin is viewing a student through
 * a short-lived preview session, carry that session token to every student
 * route; otherwise the normal admin localStorage session would take over and
 * the student page would redirect back to /admin.
 *
 * The inner component uses useSearchParams(), so keep it behind Suspense to
 * satisfy Next.js production prerendering requirements.
 */
type NavProps = { previewMode?: boolean; hidePayments?: boolean };

function StudentBottomNavInner({ previewMode = false, hidePayments = false }: NavProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const previewToken = previewMode ? searchParams.get("preview_token") : null;
  const [unread, setUnread] = useState(0);

  // Unread notification count for the Messages tab badge. Best-effort:
  // the tab works fine without it.
  useEffect(() => {
    let cancelled = false;
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("sp_token")?.trim() : "";
    if (!token) return;
    fetch("/api/notifications?count=1", {
      headers: { Authorization: `Bearer ${token}`, "x-session-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j && typeof j.unread === "number") setUnread(j.unread); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pathname]);

  function destination(path: string) {
    if (!previewToken) return path;
    return `${path}?preview_token=${encodeURIComponent(previewToken)}`;
  }

  return (
    <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: "calc(env(safe-area-inset-bottom,0px) + 12px)", width: "calc(100% - 24px)", maxWidth: 456, background: "rgba(255,255,255,0.78)", WebkitBackdropFilter: "blur(20px) saturate(1.8)", backdropFilter: "blur(20px) saturate(1.8)", border: "1px solid rgba(0,0,0,0.06)", borderRadius: 30, boxShadow: "0 8px 32px rgba(0,0,0,0.12)", display: "flex", padding: 6, zIndex: 50 }}>
      {TABS.filter(t => !(hidePayments && t.id === "payments")).map(t => {
        const isActive = pathname === t.path || (t.path === "/dashboard" && pathname === "/");
        return (
          <button
            key={t.id}
            data-tour={`nav-${t.id}`}
            onClick={() => { if (!isActive) router.push(destination(t.path)); }}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "8px 0", background: isActive ? "rgba(120,120,128,0.12)" : "none", borderRadius: 24, border: "none", cursor: "pointer", position: "relative", transition: "background .2s ease" }}
          >
            <span style={{ position: "relative", display: "inline-flex" }}>
              <t.Icon size={20} strokeWidth={isActive ? 2.1 : 1.8} color={isActive ? ACCENT : ui.textTertiary} />
              {t.id === "messages" && unread > 0 && (
                <span
                  style={{
                    position: "absolute", top: -6, right: -10,
                    minWidth: 16, height: 16, padding: "0 4px",
                    borderRadius: 999, background: "#ff3b30", color: "#fff",
                    fontSize: 10, fontWeight: 700, lineHeight: "16px", textAlign: "center",
                  }}
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: isActive ? 600 : 500, color: isActive ? ACCENT : ui.textTertiary }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * hidePayments: once a student's payment is approved there is nothing left to
 * do on the Payments tab, so the tab is dropped from the bar. The /payments
 * route itself still works (old links, notifications), it just isn't offered.
 */
export default function StudentBottomNav({ previewMode = false, hidePayments = false }: NavProps) {
  return (
    <Suspense fallback={null}>
      <StudentBottomNavInner previewMode={previewMode} hidePayments={hidePayments} />
    </Suspense>
  );
}
