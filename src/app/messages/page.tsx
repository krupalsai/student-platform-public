"use client";
import { useEffect, useState } from "react";
import { ChevronRight, MessageCircle, Paperclip, AlertCircle, Bell } from "lucide-react";
import StudentPageHeader from "@/components/student/StudentPageHeader";
import StudentBottomNav from "@/components/student/StudentBottomNav";
import CoachMarkTour from "@/components/CoachMarkTour";
import { useStudentData } from "@/lib/hooks/useStudentData";
import { ui } from "@/lib/student-ui";
import LoadFailed from "@/components/student/LoadFailed";

const ACCENT = ui.accent;

/**
 * Messages tab — everything communication-related in one place:
 * announcements (urgent ones first) and the entry point into Batch
 * Discussion. Reuses the announcements array useStudentData already
 * loads (no extra fetch) for the recent feed; "View All" hands off to
 * the existing, richer /announcements page (full history) rather than
 * reimplementing that fetch/filter logic here.
 */
/** Inbox entry card: payment updates, reminders and account notices. */
function NotificationsCard({ navigate }: { navigate: (p: string) => void }) {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("sp_token")?.trim() : "";
    if (!token) return;
    fetch("/api/notifications?count=1", {
      headers: { Authorization: `Bearer ${token}`, "x-session-token": token },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && typeof j.unread === "number") setUnread(j.unread); })
      .catch(() => {});
  }, []);
  return (
    <button onClick={() => navigate("/notifications")}
      style={{ width: "100%", background: ui.surface, border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card, borderRadius: ui.radius.card, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: ui.radius.tile, background: ui.accentSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, position: "relative" }}>
          <Bell size={18} strokeWidth={1.8} color={ACCENT} />
          {unread != null && unread > 0 && (
            <span style={{ position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, background: "#d7332a", color: "#fff", fontSize: 10, fontWeight: 700, lineHeight: "18px", textAlign: "center" }}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </div>
        <div style={{ textAlign: "left" }}>
          <p style={{ color: ui.textPrimary, fontWeight: 600, fontSize: 13, margin: 0 }}>Notifications</p>
          <p style={{ color: ui.textSecondary, fontSize: 11.5, margin: "2px 0 0" }}>
            {unread != null && unread > 0 ? `${unread} new update${unread === 1 ? "" : "s"} for you` : "Payment updates, reminders and notices"}
          </p>
        </div>
      </div>
      <ChevronRight size={18} strokeWidth={1.8} color={ui.textTertiary} />
    </button>
  );
}

export default function MessagesPage() {
  const {
    loading, loadError, reload, announcements, groupChatEnabled, previewMode, isRegisteredWithBatch,
    navigate, isApproved, nothingToPay,
  } = useStudentData();

  const urgent = announcements.filter((a: any) => a.priority === "urgent");
  const normal = announcements.filter((a: any) => a.priority !== "urgent");

  return (
    <main style={{ minHeight: "100vh", background: ui.canvas, paddingBottom: 108 }}>
      {loadError && <LoadFailed onRetry={reload} />}
      <StudentPageHeader title="Messages" sub="Announcements and your Batch Discussion" />

      <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        <NotificationsCard navigate={navigate} />
        {!loading && groupChatEnabled && (
          isRegisteredWithBatch ? (
            <button onClick={() => navigate("/discussion")} data-tour="discussion-button"
              style={{ width: "100%", background: ui.surface, border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card, borderRadius: ui.radius.card, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: ui.radius.tile, background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <MessageCircle size={18} strokeWidth={1.8} color={ui.textPrimary} />
                </div>
                <div style={{ textAlign: "left" }}>
                  <p style={{ color: ui.textPrimary, fontWeight: 600, fontSize: 13, margin: 0 }}>Batch Discussion</p>
                  <p style={{ color: ui.textSecondary, fontSize: 11.5, margin: "2px 0 0" }}>Chat with your batch and admins</p>
                </div>
              </div>
              <ChevronRight size={18} strokeWidth={1.8} color={ui.textTertiary} />
            </button>
          ) : (
            <div style={{ width: "100%", background: ui.surface, border: `1px solid ${ui.border}`, borderRadius: ui.radius.card, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: ui.radius.tile, background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <MessageCircle size={16} strokeWidth={1.8} color={ui.textTertiary} />
              </div>
              <div>
                <p style={{ color: ui.textSecondary, fontWeight: 600, fontSize: 13, margin: 0 }}>Batch Discussion</p>
                <p style={{ color: ui.textTertiary, fontSize: 11.5, margin: "2px 0 0" }}>Unlocks once your registration is complete</p>
              </div>
            </div>
          )
        )}

        {urgent.map((a: any) => (
          <div key={a.id} style={{ background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, borderRadius: ui.radius.card, padding: "14px 16px" }}>
            <p style={{ color: ui.danger, fontWeight: 600, fontSize: 13, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              <AlertCircle size={14} strokeWidth={2} /> {a.title}
            </p>
            <p style={{ color: ui.danger, fontSize: 12, lineHeight: 1.6, margin: 0, opacity: 0.85 }}>{a.body}</p>
            {a.attachment_url && (
              <a href={a.attachment_url} target="_blank" rel="noopener noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, background: "#fff", color: ui.danger, fontSize: 12, fontWeight: 500, padding: "6px 10px", borderRadius: ui.radius.sm, textDecoration: "none", border: `1px solid ${ui.dangerSoftBorder}` }}>
                <Paperclip size={12} strokeWidth={2} /> {a.attachment_name ?? "View Document"}
              </a>
            )}
          </div>
        ))}

        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: ui.textTertiary, textTransform: "uppercase", letterSpacing: 1, margin: 0 }}>Announcements</p>
            <button onClick={() => navigate("/announcements")}
              style={{ fontSize: 11, fontWeight: 600, color: ACCENT, background: "none", border: "none", cursor: "pointer" }}>
              View All
            </button>
          </div>
          {loading ? (
            <div style={{ height: 60, background: ui.surface, borderRadius: ui.radius.button, border: `1px solid ${ui.border}` }} />
          ) : normal.length === 0 ? (
            <div style={{ background: ui.surface, borderRadius: ui.radius.button, padding: "24px 16px", border: `1px solid ${ui.border}`, textAlign: "center" }}>
              <p style={{ fontSize: 13, color: ui.textTertiary, margin: 0 }}>No announcements right now</p>
            </div>
          ) : normal.map((a: any) => (
            <div key={a.id} style={{ background: ui.surface, borderRadius: ui.radius.button, padding: "14px 16px", border: `1px solid ${ui.border}`, marginBottom: 10 }}>
              <p style={{ fontWeight: 600, fontSize: 13, color: ui.textPrimary, margin: 0 }}>{a.title}</p>
              <p style={{ fontSize: 12, color: ui.textSecondary, margin: "6px 0 0", lineHeight: 1.6 }}>{a.body}</p>
              {a.attachment_url && (
                <a href={a.attachment_url} target="_blank" rel="noopener noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, background: ui.accentSoft, color: ACCENT, fontSize: 12, fontWeight: 500, padding: "6px 10px", borderRadius: ui.radius.sm, textDecoration: "none" }}>
                  <Paperclip size={12} strokeWidth={2} /> {a.attachment_name ?? "View Document"}
                </a>
              )}
              <p style={{ fontSize: 10, color: ui.textTertiary, margin: "8px 0 0" }}>
                {new Date(a.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
              </p>
            </div>
          ))}
        </div>
      </div>

      <StudentBottomNav previewMode={previewMode} hidePayments={nothingToPay} />

      {!loading && !previewMode && groupChatEnabled && isRegisteredWithBatch && (
        <CoachMarkTour tourKey="messages" steps={[
          { selector: '[data-tour="discussion-button"]', title: "Batch Discussion", text: "Tap here to chat with your batch and admins — text and photos." },
        ]} />
      )}
    </main>
  );
}
