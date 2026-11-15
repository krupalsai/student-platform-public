"use client";

import { useEffect, useState } from "react";
import { Phone, Search, X } from "lucide-react";
import { useVoiceCall } from "@/lib/hooks/useVoiceCall";

type CallApi = ReturnType<typeof useVoiceCall>;
type Batch = { id: string; name: string };
type Student = { id: string; full_name: string | null; phone: string | null };

function headers(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("sp_token")?.trim() : "";
  if (!token) return {};
  return { Authorization: `Bearer ${token}`, "x-session-token": token };
}

export default function AdminCallbackPanel({ call }: { call: CallApi }) {
  const [open, setOpen] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [studentId, setStudentId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    fetch("/api/admin/batches?active_only=1", { headers: headers(), cache: "no-store" })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error ?? "Could not load batches.");
        setBatches((j.data ?? []).map((b: any) => ({ id: b.id, name: b.name })));
      })
      .catch(e => setError(e.message));
  }, [open]);

  useEffect(() => {
    if (!batchId) {
      setStudents([]);
      return;
    }
    setLoading(true);
    setStudentId("");
    fetch(`/api/admin/students?batch_id=${encodeURIComponent(batchId)}&page=1`, {
      headers: headers(), cache: "no-store",
    })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error ?? "Could not load students.");
        setStudents((j.students ?? j.data?.students ?? []).map((s: any) => ({
          id: s.id, full_name: s.full_name, phone: s.phone,
        })));
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [batchId]);

  const loadHistory = () => {
    setHistoryLoading(true);
    setError(null);
    fetch("/api/admin/call-history?limit=100", { headers: headers(), cache: "no-store" })
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error ?? "Could not load call history.");
        setHistory(j.calls ?? j.data?.calls ?? []);
        setHistoryOpen(true);
        setOpen(true);
      })
      .catch(e => setError(e.message))
      .finally(() => setHistoryLoading(false));
  };

  const formatDate = (value: string) => {
    try {
      return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      }).format(new Date(value));
    } catch {
      return value;
    }
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds || seconds < 1) return "—";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins ? `${mins}m ${secs}s` : `${secs}s`;
  };

  if (!open) {
    return (
      <div style={{ display: "flex", gap: 7 }}>
        <button
          onClick={() => setOpen(true)}
          disabled={call.phase !== "idle"}
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            border: "1px solid #cfe2ff", background: "#f2f7ff",
            color: "#0062cc", borderRadius: 11, padding: "11px 12px",
            fontWeight: 700, fontSize: 13, cursor: call.phase === "idle" ? "pointer" : "not-allowed",
          }}
        >
          <Phone size={15} /> Call a student
        </button>
        <button
          onClick={loadHistory}
          disabled={historyLoading}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            border: "1px solid #e2e8f0", background: "#fff",
            color: "#334155", borderRadius: 11, padding: "11px 12px",
            fontWeight: 700, fontSize: 13, cursor: historyLoading ? "wait" : "pointer",
          }}
        >
          {historyLoading ? "Loading…" : "History"}
        </button>
      </div>
    );
  }

  if (historyOpen) {
    return (
      <div style={{ marginTop: 10, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <strong style={{ fontSize: 14, color: "#0f172a" }}>Call history</strong>
          <button onClick={() => setHistoryOpen(false)} aria-label="Close" style={{ border: 0, background: "none", color: "#64748b", cursor: "pointer" }}>
            <X size={17} />
          </button>
        </div>
        <div style={{ maxHeight: 390, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {history.length ? history.map(h => (
            <div key={h.id} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#0f172a" }}>{h.student_name}</div>
                  <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                    {[h.batch_name, h.student_phone].filter(Boolean).join(" · ") || "No batch"}
                  </div>
                </div>
                <span style={{
                  flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "4px 7px",
                  background: h.status === "ended" ? "#dcfce7" : h.status === "missed" ? "#fee2e2" : h.status === "declined" ? "#fef3c7" : "#e8f1ff",
                  color: h.status === "ended" ? "#166534" : h.status === "missed" ? "#991b1b" : h.status === "declined" ? "#92400e" : "#0051a8",
                }}>
                  {h.status === "ended" ? "Completed" : h.status === "missed" ? "Missed" : h.status === "declined" ? "Declined" : h.status}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 7, fontSize: 11, color: "#64748b" }}>
                <span>{h.direction === "callback" ? "Callback" : "Student call"}</span>
                <span>{formatDuration(h.duration_secs)}</span>
                <span>{formatDate(h.created_at)}</span>
              </div>
            </div>
          )) : (
            <p style={{ margin: 4, fontSize: 12, color: "#64748b" }}>No call history yet.</p>
          )}
        </div>
        {error && <p style={{ color: "#b91c1c", fontSize: 12, margin: "9px 0 0" }}>{error}</p>}
        <button
          onClick={() => { setHistoryOpen(false); setOpen(false); }}
          style={{ width: "100%", marginTop: 10, border: "1px solid #e2e8f0", background: "#fff", color: "#334155", borderRadius: 9, padding: "9px", fontWeight: 700, cursor: "pointer" }}
        >
          Close
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={call.phase !== "idle"}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          width: "100%", border: "1px solid #cfe2ff", background: "#f2f7ff",
          color: "#0062cc", borderRadius: 11, padding: "11px 12px",
          fontWeight: 700, fontSize: 13, cursor: call.phase === "idle" ? "pointer" : "not-allowed",
        }}
      >
        <Phone size={15} /> Call a student
      </button>
    );
  }

  const filtered = students.filter(s =>
    !search.trim() ||
    (s.full_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (s.phone ?? "").includes(search.trim())
  );

  return (
    <div style={{ marginTop: 10, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <strong style={{ fontSize: 14, color: "#0f172a" }}>Callback</strong>
        <button onClick={() => setOpen(false)} aria-label="Close" style={{ border: 0, background: "none", color: "#64748b", cursor: "pointer" }}>
          <X size={17} />
        </button>
      </div>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b" }}>
        Select the batch, then the student who missed your call. The callback rings that student only.
      </p>

      <select
        value={batchId}
        onChange={e => setBatchId(e.target.value)}
        style={{ width: "100%", border: "1px solid #cbd5e1", borderRadius: 9, padding: "10px 11px", background: "#fff", marginBottom: 9 }}
      >
        <option value="">Select batch</option>
        {batches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>

      {batchId && (
        <>
          <div style={{ position: "relative", marginBottom: 9 }}>
            <Search size={15} style={{ position: "absolute", left: 10, top: 11, color: "#94a3b8" }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search student"
              style={{ width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 9, padding: "10px 10px 10px 32px" }}
            />
          </div>
          <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {loading ? <p style={{ fontSize: 12, color: "#64748b" }}>Loading students…</p> :
              filtered.length ? filtered.map(s => (
                <button
                  key={s.id}
                  onClick={() => setStudentId(s.id)}
                  style={{
                    textAlign: "left", border: studentId === s.id ? "2px solid #007aff" : "1px solid #e2e8f0",
                    background: studentId === s.id ? "#f2f7ff" : "#fff", borderRadius: 9, padding: "9px 10px", cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#0f172a" }}>{s.full_name || "Student"}</div>
                  {s.phone && <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{s.phone}</div>}
                </button>
              )) : <p style={{ fontSize: 12, color: "#64748b" }}>No students found in this batch.</p>}
          </div>
        </>
      )}

      {error && <p style={{ color: "#b91c1c", fontSize: 12, margin: "9px 0 0" }}>{error}</p>}

      <button
        disabled={!studentId || call.phase !== "idle"}
        onClick={() => {
          void call.startCallback(studentId, batchId);
          setOpen(false);
        }}
        style={{
          width: "100%", marginTop: 11, border: 0, borderRadius: 9, padding: "11px",
          background: !studentId || call.phase !== "idle" ? "#cbd5e1" : "#16a34a",
          color: "#fff", fontWeight: 700, cursor: !studentId || call.phase !== "idle" ? "not-allowed" : "pointer",
        }}
      >
        <Phone size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
        Start callback
      </button>
    </div>
  );
}
