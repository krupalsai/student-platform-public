"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  KeyRound, FileEdit, CheckCircle2, CreditCard, Rocket, Send, XCircle,
  Home, Map, Megaphone, Eye, Scale, FileText, Download, HelpCircle,
  Settings, LogOut, Circle, X,
  type LucideIcon,
} from "lucide-react";

const EVENT_ICONS: Record<string, LucideIcon> = {
  "session.created":          KeyRound,
  "registration.started":     FileEdit,
  "registration.completed":   CheckCircle2,
  "payment.page_opened":      CreditCard,
  "payment.initiated":        Rocket,
  "payment.submitted":        Send,
  "payment.approved":         CheckCircle2,
  "payment.rejected":         XCircle,
  "dashboard.opened":         Home,
  "route_map.opened":         Map,
  "announcements.opened":     Megaphone,
  "announcement.viewed":      Eye,
  "petition.viewed":          Scale,
  "documents.viewed":         FileText,
  "document.downloaded":      Download,
  "faq.viewed":               HelpCircle,
  "settings.opened":          Settings,
  "session.ended":            LogOut,
};

const FUNNEL_STEPS = [
  { key: "registration.started",   label: "Started Registration" },
  { key: "registration.completed", label: "Completed Registration" },
  { key: "payment.page_opened",    label: "Opened Payment Page" },
  { key: "payment.initiated",      label: "Initiated Payment" },
  { key: "payment.submitted",      label: "Submitted Payment" },
  { key: "payment.approved",       label: "Payment Approved" },
];

function Skel({ h = 60 }: { h?: number }) {
  return <div style={{ height: h, borderRadius: 14, background: "#f3f4f6", animation: "pulse 1.4s ease infinite" }} />;
}

function EventRow({ e }: { e: any }) {
  const Icon = EVENT_ICONS[e.event_type] ?? Circle;
  const time = new Date(e.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div style={{ display: "flex", gap: 12, padding: "12px 16px", borderBottom: "1px solid #f3f4f6", alignItems: "flex-start" }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: "#f2f7ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icon size={16} strokeWidth={2} color="#0062cc" /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{e.event_type}</span>
          {e.college && <span style={{ fontSize: 10, background: "#e8f1ff", color: "#007aff", borderRadius: 6, padding: "2px 7px", fontWeight: 700 }}>{e.college}</span>}
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
          {e.student.name}{e.student.roll ? ` · ${e.student.roll}` : ""}
          {e.page ? <span style={{ color: "#d1d5db" }}> · {e.page}</span> : null}
        </div>
        <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{time}</div>
      </div>
    </div>
  );
}

export default function StudentAnalyticsPage() {
  const router = useRouter();
  const [data, setData]         = useState<any>(null);
  const [loading, setLoading]   = useState(true);
  const [college, setCollege]   = useState<string>("ALL");
  // Fetched, not a hardcoded ALL/GNIT/GNITC union — same trap as items
  // #101/#107/#114/#118, this time on the activity filter.
  const [colleges, setColleges] = useState<{ id: string; name: string }[]>([
    { id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" },
  ]);
  const [eventType, setEventType] = useState<string>("");
  const [days, setDays]         = useState(7);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  useEffect(() => {
    fetch("/api/settings/colleges").then(r => r.json()).then(j => {
      if (Array.isArray(j.data) && j.data.length) setColleges(j.data);
    }).catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ days: String(days) });
    if (college !== "ALL") params.set("college", college);
    if (eventType) params.set("event_type", eventType);
    fetch(`/api/admin/analytics/students?${params}`, { headers: h() })
      .then(r => r.json())
      .then(j => { if (j.success) setData(j.data); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, [college, eventType, days]);

  const funnel: Record<string, number> = data?.funnel ?? {};
  const events: any[] = data?.events ?? [];
  const topTypes = Object.entries(data?.type_counts ?? {})
    .sort(([,a],[,b]) => (b as number) - (a as number))
    .slice(0, 12) as [string, number][];
  const maxCount = Math.max(...topTypes.map(([,c]) => c as number), 1);

  return (
    <div style={{ minHeight: "100vh", background: "#f8f8fb", paddingBottom: 40, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg,#1a0a3c 0%,#3730a3 100%)", padding: "48px 20px 20px" }}>
        <button onClick={() => router.back()} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.15)", border: "1.5px solid rgba(255,255,255,0.25)", borderRadius: 14, padding: "8px 16px 8px 10px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 18 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ color: "#fff", fontSize: 22, fontWeight: 900, margin: 0 }}>Student Activity</h1>
            <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, margin: "4px 0 0" }}>What students actually do inside the app</p>
          </div>
          <button onClick={load} style={{ width: 36, height: 36, borderRadius: 50, background: "rgba(255,255,255,0.15)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          {["ALL", ...colleges.map(c => c.id)].map(c => (
            <button key={c} onClick={() => setCollege(c)} style={{ padding: "7px 16px", borderRadius: 50, border: "none", cursor: "pointer", background: college === c ? "#fff" : "rgba(255,255,255,0.15)", color: college === c ? "#3730a3" : "#fff", fontSize: 13, fontWeight: 700 }}>{c}</button>
          ))}
          {([7,14,30] as const).map(d => (
            <button key={d} onClick={() => setDays(d)} style={{ padding: "7px 16px", borderRadius: 50, border: "none", cursor: "pointer", background: days === d ? "#fff" : "rgba(255,255,255,0.15)", color: days === d ? "#3730a3" : "#fff", fontSize: 13, fontWeight: 700 }}>{d}d</button>
          ))}
        </div>
      </div>

      <div style={{ padding: "16px 16px 0", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Funnel */}
        <div style={{ background: "#fff", borderRadius: 18, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1, padding: "14px 16px 8px", margin: 0 }}>Registration → Payment Funnel</p>
          {loading ? <div style={{ padding: 16 }}><Skel /><Skel /></div> : FUNNEL_STEPS.map((step, i) => {
            const count = funnel[step.key] ?? 0;
            const prev = i === 0 ? count : (funnel[FUNNEL_STEPS[i-1].key] ?? count);
            const pct = prev > 0 ? Math.round((count / prev) * 100) : 0;
            return (
              <div key={step.key} style={{ padding: "10px 16px", borderTop: i === 0 ? "none" : "1px solid #f9fafb" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: "#374151", fontWeight: 600 }}>{step.label}</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#3730a3" }}>{count} {i > 0 && <span style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600 }}>({pct}%)</span>}</span>
                </div>
                <div style={{ height: 6, background: "#f3f4f6", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 99, background: "linear-gradient(90deg,#007aff,#0062cc)", width: prev > 0 ? `${pct}%` : "100%", transition: "width 0.6s ease" }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Top event types */}
        {!loading && topTypes.length > 0 && (
          <div style={{ background: "#fff", borderRadius: 18, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1, padding: "14px 16px 8px", margin: 0 }}>Feature Usage (last {days}d)</p>
            {topTypes.map(([type, count]) => (
              <button key={type} onClick={() => setEventType(eventType === type ? "" : type)}
                style={{ width: "100%", padding: "10px 16px", borderTop: "1px solid #f9fafb", background: eventType === type ? "#f2f7ff" : "none", border: "none", cursor: "pointer", textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {(() => { const Icon = EVENT_ICONS[type] ?? Circle; return <Icon size={16} strokeWidth={2} color="#0062cc" style={{ flexShrink: 0 }} />; })()}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontSize: 12, color: "#374151", fontWeight: 600 }}>{type}</span>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "#007aff" }}>{count}</span>
                    </div>
                    <div style={{ height: 4, background: "#f3f4f6", borderRadius: 99, marginTop: 5 }}>
                      <div style={{ height: "100%", borderRadius: 99, background: "#007aff", width: `${Math.round((count / maxCount) * 100)}%` }} />
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {eventType && (
              <button onClick={() => setEventType("")} style={{ width: "100%", padding: "10px 16px", borderTop: "1px solid #f9fafb", background: "#fef9c3", border: "none", cursor: "pointer", fontSize: 12, color: "#92400e", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <X size={12} strokeWidth={2} /> Clear filter: {eventType}
              </button>
            )}
          </div>
        )}

        {/* Event timeline */}
        <div style={{ background: "#fff", borderRadius: 18, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}>
          <p style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1, padding: "14px 16px 8px", margin: 0 }}>
            Recent Events {events.length >= 500 ? "(latest 500)" : `(${events.length})`}
          </p>
          {loading ? [1,2,3,4,5].map(i => <div key={i} style={{ padding: "12px 16px", borderBottom: "1px solid #f3f4f6" }}><Skel /></div>)
            : events.length === 0
              ? <div style={{ padding: 32, textAlign: "center", color: "#9ca3af", fontSize: 14 }}>No events in this period.</div>
              : events.map(e => <EventRow key={e.id} e={e} />)
          }
        </div>
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}`}</style>
    </div>
  );
}
