"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check, X, Paperclip, KeyRound, UserPlus, Package, Pencil, Pause,
  Trash2, Shuffle, LogIn, RefreshCw, ClipboardList, RotateCw,
  type LucideIcon,
} from "lucide-react";

function timeAgo(iso: string) {
  if (!iso) return "never";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)    return `${Math.round(diff)}s ago`;
  if (diff < 3600)  return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function fmtTime(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

const ACTION_LABELS: Record<string, { Icon: LucideIcon; label: string }> = {
  "payment.approved":           { Icon: Check,       label: "Approved a payment"        },
  "payment.rejected":           { Icon: X,           label: "Rejected a payment"        },
  "payment.reupload_requested": { Icon: Paperclip,   label: "Requested re-upload"       },
  "user.role_changed":          { Icon: KeyRound,    label: "Changed a user role"       },
  "user.created":               { Icon: UserPlus,    label: "Added a new user"          },
  "batch.created":              { Icon: Package,     label: "Created a batch"           },
  "batch.updated":              { Icon: Pencil,      label: "Updated a batch"           },
  "batch.status_changed":       { Icon: Pause,       label: "Changed batch status"      },
  "student.deleted":            { Icon: Trash2,      label: "Deleted a student"         },
  "student.batch_corrected":    { Icon: Shuffle,     label: "Corrected student batch"   },
  "session.created":            { Icon: LogIn,       label: "Logged in"                 },
  "profile.correction":         { Icon: RefreshCw,   label: "Corrected a profile"       },
};

export default function AuditPage() {
  const router = useRouter();
  const [admins, setAdmins]   = useState<any[]>([]);
  const [logs,   setLogs]     = useState<any[]>([]);
  const [total,  setTotal]    = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [offset,  setOffset]  = useState(0);
  const LIMIT = 50;

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  function load(off = 0) {
    setLoading(true);
    setError("");
    const q = new URLSearchParams({ limit: String(LIMIT), offset: String(off), filter: "admins" });
    fetch(`/api/admin/audit?${q}`, { headers: h() })
      .then(r => r.json())
      .then(j => {
        if (!j.success) { setError(j.error ?? "Failed to load"); setLoading(false); return; }
        setAdmins(j.data?.adminActivity ?? []);
        setLogs(j.data?.logs ?? []);
        setTotal(j.data?.total ?? 0);
        setLoading(false);
      })
      .catch(e => { setError("Network error — " + e.message); setLoading(false); });
  }

  useEffect(() => { load(0); }, []);

  return (
    <div style={{ minHeight: "100vh", background: "#f8f9fa", paddingBottom: 40 }}>

      {/* Header */}
      <div style={{ background: "#0062cc", padding: "48px 16px 20px" }}>
        <button onClick={() => router.back()}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.15)", border: "1.5px solid rgba(255,255,255,0.25)", borderRadius: 14, padding: "8px 14px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 16 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ color: "#fff", fontSize: 20, fontWeight: 700, margin: 0 }}>Admin Activity</h1>
          </div>
          <button onClick={() => load(offset)}
            style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 12, padding: "8px 12px", color: "#fff", cursor: "pointer" }}>
            <RotateCw size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div style={{ padding: "16px 16px 0" }}>

        {error && (
          <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 14, padding: "12px 16px", color: "#dc2626", fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {loading ? (
          <p style={{ textAlign: "center", color: "#9ca3af", padding: "40px 0", fontSize: 14 }}>Loading…</p>
        ) : (
          <>
            {/* ── Admin online status cards ─────────────────────────── */}
            <p style={{ fontSize: 11, fontWeight: 800, color: "#9ca3af", letterSpacing: 1, marginBottom: 8 }}>ADMINS</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
              {admins.map(a => {
                const minsAgo = a.last_active_at
                  ? (Date.now() - new Date(a.last_active_at).getTime()) / 60000
                  : Infinity;
                const isOnline = minsAgo < 5;
                const isRecent = minsAgo < 60;
                return (
                  <div key={a.id} style={{ background: "#fff", borderRadius: 16, padding: "14px 16px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 14 }}>
                    <div style={{ position: "relative", flexShrink: 0 }}>
                      <div style={{ width: 44, height: 44, borderRadius: 14, background: "#e8f1ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#007aff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                        </svg>
                      </div>
                      <div style={{ position: "absolute", bottom: 0, right: 0, width: 12, height: 12, borderRadius: "50%", border: "2px solid #fff", background: isOnline ? "#22c55e" : isRecent ? "#f59e0b" : "#d1d5db" }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontSize: 15, fontWeight: 800, color: "#111827", margin: 0, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {a.full_name ?? a.username ?? "Unknown"}
                        {a.batches?.name && (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "#eef2ff", color: "#4f46e5", whiteSpace: "nowrap" }}>
                            {a.batches.name}
                          </span>
                        )}
                      </p>
                      <p style={{ fontSize: 12, color: "#6b7280", margin: "2px 0 0" }}>
                        {a.role} ·{" "}
                        <span style={{ color: isOnline ? "#16a34a" : "#9ca3af", fontWeight: isOnline ? 700 : 400 }}>
                          {isOnline ? "Online now" : `Last seen ${timeAgo(a.last_active_at)}`}
                        </span>
                      </p>
                    </div>
                    <p style={{ fontSize: 11, color: "#9ca3af", margin: 0, textAlign: "right", flexShrink: 0 }}>
                      {a.last_active_at ? fmtTime(a.last_active_at) : "Never logged in"}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* ── Action log ───────────────────────────────────────── */}
            <p style={{ fontSize: 11, fontWeight: 800, color: "#9ca3af", letterSpacing: 1, marginBottom: 8 }}>ACTION HISTORY</p>
            {logs.length === 0 ? (
              <p style={{ color: "#9ca3af", fontSize: 13, textAlign: "center", padding: "24px 0" }}>No admin actions recorded yet</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {logs.map(l => {
                  const info = ACTION_LABELS[l.action] ?? { Icon: ClipboardList, label: l.action };
                  return (
                    <div key={l.id} style={{ background: "#fff", borderRadius: 16, padding: "12px 14px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)", display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ width: 32, height: 32, borderRadius: 9, background: "#f2f7ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <info.Icon size={15} strokeWidth={2} color="#0062cc" />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 700, color: "#111827", margin: 0 }}>{info.label}</p>
                        <p style={{ fontSize: 11, color: "#6b7280", margin: "2px 0 0" }}>
                          {l.profiles?.full_name ?? l.profiles?.username ?? l.actor_role}
                        </p>
                      </div>
                      <p style={{ fontSize: 11, color: "#9ca3af", margin: 0, flexShrink: 0, whiteSpace: "nowrap" }}>{timeAgo(l.created_at)}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {total > LIMIT && (
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button disabled={offset === 0} onClick={() => { const o = Math.max(0, offset - LIMIT); setOffset(o); load(o); }}
                  style={{ flex: 1, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 0", fontSize: 13, cursor: "pointer", opacity: offset === 0 ? 0.4 : 1 }}>← Prev</button>
                <button disabled={offset + LIMIT >= total} onClick={() => { const o = offset + LIMIT; setOffset(o); load(o); }}
                  style={{ flex: 1, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 0", fontSize: 13, cursor: "pointer", opacity: offset + LIMIT >= total ? 0.4 : 1 }}>Next →</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
