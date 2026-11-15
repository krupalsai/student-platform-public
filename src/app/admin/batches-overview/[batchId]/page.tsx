"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";
import { GraduationCap, Check, X, AlertTriangle, Scale, type LucideIcon } from "lucide-react";

interface BatchStats {
  batch: {
    id: string; name: string; slug: string; college: string; fee_amount: number; status: string;
    case_type: string | null; case_number: string | null; case_year: string | null; case_status_url: string | null;
  };
  total_students: number;
  paid_students: number;
  not_paid_students: number;
  failed_payments: number;
  total_collected: number;
}

const COLLEGE_THEME: Record<string, { color: string }> = {
  GNIT:  { color: "#ef4444" },
  GNITC: { color: "#475569" },
};

function Skel({ h = 90 }: { h?: number }) {
  return <div style={{ height: h, borderRadius: 18, background: "rgba(0,0,0,0.06)", animation: "pulse 1.4s ease infinite" }} />;
}

function Stat({ Icon, value, label, color, bg, onClick }: { Icon: LucideIcon; value: string | number; label: string; color: string; bg: string; onClick?: () => void }) {
  const [p, setP] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      onPointerDown={() => onClick && setP(true)} onPointerUp={() => setP(false)} onPointerLeave={() => setP(false)}
      style={{
        background: "#fff", borderRadius: 18, padding: "16px 14px", border: "1.5px solid #f0f0f0",
        textAlign: "left", cursor: onClick ? "pointer" : "default", width: "100%",
        transform: p ? "scale(0.96)" : "scale(1)",
        boxShadow: p ? `0 6px 18px ${color}22` : "none",
        transition: "all 0.15s cubic-bezier(0.34,1.56,0.64,1)",
      }}>
      <span style={{ width: 38, height: 38, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}><Icon size={17} strokeWidth={2} color={color} /></span>
      <p style={{ fontSize: 22, fontWeight: 700, color, margin: 0, lineHeight: 1 }}>{value}</p>
      <p style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, marginTop: 5 }}>{label}</p>
      {onClick && (
        <span style={{ display: "flex", alignItems: "center", gap: 2, marginTop: 6, fontSize: 10, fontWeight: 700, color }}>
          View list
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </span>
      )}
    </button>
  );
}

const IconEdit = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>);
const IconPause = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>);
const IconPlay = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>);
const IconArchive = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8H3v13h18V8Z"/><path d="M1 3h22v5H1z"/><line x1="10" y1="12" x2="14" y2="12"/></svg>);
const IconTrash = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>);
const IconChat = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>);

function ActionBtn({ icon, label, onClick, tone = "default", disabled }: { icon: ReactNode; label: string; onClick: () => void; tone?: "default" | "danger"; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
      background: "#fff", border: "1px solid #f0f0f0", borderRadius: 14, padding: "13px 16px",
      fontSize: 14, fontWeight: 600, color: tone === "danger" ? "#dc2626" : "#111827",
      cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
    }}>
      <span style={{ color: tone === "danger" ? "#dc2626" : "#6b7280", display: "flex" }}>{icon}</span>
      {label}
    </button>
  );
}

export default function BatchDetailPage() {
  const router = useRouter();
  const params = useParams() as { batchId: string };
  const [stats, setStats] = useState<BatchStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Court case number — a top-of-page action, not buried under "Manage
  // batch" at the bottom. Live-reported: "this case number there on top not
  // some place" after it was only reachable from the Batches list page.
  const [caseOpen, setCaseOpen] = useState(false);
  const [caseForm, setCaseForm] = useState({ case_type: "", case_number: "", case_year: "", case_status_url: "" });
  const [savingCase, setSavingCase] = useState(false);
  const [showCaseAdvanced, setShowCaseAdvanced] = useState(false);
  const DEFAULT_CASE_TYPE = "WP";
  const DEFAULT_CASE_STATUS_URL = "https://csis.tshc.gov.in/";

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });
  const hJson = () => ({ ...h(), "Content-Type": "application/json" });

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2500); }

  function loadStats() {
    fetch(`/api/admin/batches/${params.batchId}/stats`, { headers: h(), cache: "no-store" })
      .then(r => r.json())
      .then(j => { if (j.success) setStats(j.data); setLoading(false); })
      .catch(() => setLoading(false));
  }
  useEffect(() => { loadStats(); }, [params.batchId]);

  async function toggleStatus() {
    if (!stats) return;
    setBusy(true);
    const newStatus = stats.batch.status === "active" ? "closed" : "active";
    const res = await fetch(`/api/admin/batches/${params.batchId}`, { method: "PATCH", headers: h(), body: JSON.stringify({ status: newStatus }) });
    const j = await res.json();
    setBusy(false);
    if (j.success) { showToast(newStatus === "closed" ? "Batch closed" : "Batch resumed"); loadStats(); } else showToast(j.error ?? "Update failed");
  }

  async function archiveBatch() {
    setBusy(true);
    const res = await fetch(`/api/admin/batches/${params.batchId}`, { method: "PATCH", headers: h(), body: JSON.stringify({ status: "archived" }) });
    const j = await res.json();
    setBusy(false);
    if (j.success) { showToast("Batch archived"); loadStats(); } else showToast(j.error ?? "Archive failed");
  }

  function openCaseModal() {
    if (!stats) return;
    setCaseForm({
      case_type: stats.batch.case_type ?? DEFAULT_CASE_TYPE,
      case_number: stats.batch.case_number ?? "",
      case_year: stats.batch.case_year ?? String(new Date().getFullYear()),
      case_status_url: stats.batch.case_status_url ?? DEFAULT_CASE_STATUS_URL,
    });
    setShowCaseAdvanced(false);
    setCaseOpen(true);
  }

  async function saveCaseDetails() {
    if (!caseForm.case_number.trim()) { showToast("Enter the case number"); return; }
    setSavingCase(true);
    const payload = {
      case_type: caseForm.case_type.trim(),
      case_number: caseForm.case_number.trim(),
      case_year: caseForm.case_year.trim(),
      case_status_url: caseForm.case_status_url.trim(),
    };
    const res = await fetch(`/api/admin/batches/${params.batchId}`, { method: "PATCH", headers: hJson(), body: JSON.stringify(payload) });
    const j = await res.json();
    setSavingCase(false);
    if (j.success) { setCaseOpen(false); loadStats(); showToast("Case details saved"); }
    else showToast(j.error ?? "Save failed");
  }

  async function confirmDelete() {
    setBusy(true);
    const res = await fetch(`/api/admin/batches/${params.batchId}`, { method: "DELETE", headers: h() });
    const j = await res.json();
    setBusy(false); setDeleteOpen(false);
    if (j.success) { showToast("Batch deleted"); router.back(); } else showToast(j.error ?? "Delete failed");
  }

  const theme = COLLEGE_THEME[stats?.batch.college ?? "GNIT"] ?? COLLEGE_THEME.GNIT;
  const paidPct = stats && stats.total_students > 0
    ? Math.round((stats.paid_students / stats.total_students) * 100)
    : 0;

  const [mounted, setMounted] = useState(false);
  useEffect(() => { const t = setTimeout(() => setMounted(true), 10); return () => clearTimeout(t); }, []);

  return (
    <div style={{
      minHeight: "100vh", background: "#f8fafc", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      opacity: mounted ? 1 : 0, transform: mounted ? "translateY(0)" : "translateY(12px)",
      transition: "opacity 0.32s ease, transform 0.32s cubic-bezier(0.16,1,0.3,1)",
    }}>

      {/* Header */}
      <div style={{ background: `linear-gradient(135deg, ${theme.color}, ${theme.color}dd)`, padding: "52px 20px 26px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: -30, right: -30, width: 120, height: 120, borderRadius: "50%", background: "rgba(255,255,255,0.12)" }} />
        <button onClick={() => router.back()} style={{
          display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.18)",
          border: "1.5px solid rgba(255,255,255,0.3)", borderRadius: 14, padding: "8px 16px 8px 10px",
          color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 18,
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        {loading ? (
          <div style={{ height: 30, width: 200, background: "rgba(255,255,255,0.2)", borderRadius: 8 }} />
        ) : (
          <>
            <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 11, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", margin: 0 }}>{stats?.batch.college}</p>
            <h1 style={{ color: "#fff", fontSize: 26, fontWeight: 900, margin: "4px 0 0" }}>{stats?.batch.name}</h1>
            <p style={{ color: "rgba(255,255,255,0.85)", fontSize: 13, margin: "6px 0 0" }}>Fee: ₹{Number(stats?.batch.fee_amount ?? 0).toLocaleString("en-IN")} per student</p>
            <button onClick={openCaseModal} style={{
              display: "inline-flex", alignItems: "center", gap: 7, marginTop: 12,
              background: "rgba(255,255,255,0.18)", border: "1.5px solid rgba(255,255,255,0.3)",
              borderRadius: 12, padding: "8px 14px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>
              <Scale size={14} strokeWidth={2} />
              {stats?.batch.case_number
                ? `${[stats.batch.case_type, stats.batch.case_number].filter(Boolean).join(" ")}${stats.batch.case_year ? ` / ${stats.batch.case_year}` : ""}`
                : "Add Case Number"}
            </button>
          </>
        )}
      </div>

      <div style={{ padding: "18px 16px 40px", display: "flex", flexDirection: "column", gap: 14 }}>

        {loading ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Skel /><Skel /><Skel /><Skel />
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Stat Icon={GraduationCap} value={stats?.total_students ?? 0} label="Total Students in this batch" color="#0ea5e9" bg="#e0f2fe"
                onClick={() => router.push(`/admin/students?batch_id=${params.batchId}&college=${encodeURIComponent(stats?.batch.college ?? "")}`)} />
              <Stat Icon={Check} value={stats?.paid_students ?? 0} label={`Paid (${paidPct}%)`} color="#16a34a" bg="#dcfce7"
                onClick={() => router.push(`/admin/students?batch_id=${params.batchId}&college=${encodeURIComponent(stats?.batch.college ?? "")}&pay_status=paid`)} />
              <Stat Icon={X} value={stats?.failed_payments ?? 0} label="Payment failed" color="#dc2626" bg="#fee2e2"
                onClick={() => router.push(`/admin/students?batch_id=${params.batchId}&college=${encodeURIComponent(stats?.batch.college ?? "")}&pay_status=failed`)} />
              <Stat Icon={AlertTriangle} value={stats?.not_paid_students ?? 0} label="Not paid yet" color="#ef4444" bg="#fef2f2"
                onClick={() => router.push(`/admin/students?batch_id=${params.batchId}&college=${encodeURIComponent(stats?.batch.college ?? "")}&pay_status=not_paid`)} />
            </div>

            <div style={{ background: "linear-gradient(135deg,#14532d,#16a34a)", borderRadius: 18, padding: "18px 20px" }}>
              <p style={{ color: "rgba(255,255,255,0.65)", fontSize: 11, fontWeight: 700, margin: 0, letterSpacing: 1 }}>
                COLLECTED FROM THIS BATCH
              </p>
              <p style={{ color: "#fff", fontSize: 30, fontWeight: 900, margin: "6px 0 0" }}>
                ₹{Number(stats?.total_collected ?? 0).toLocaleString("en-IN")}
              </p>
            </div>

            {/* Manage batch */}
            {stats?.batch.status !== "archived" ? (
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: 1, margin: "4px 0 10px" }}>Manage batch</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}><ActionBtn icon={<IconEdit />} label="Edit" disabled={busy} onClick={() => router.push(`/admin/batches?edit=${params.batchId}`)} /></div>
                    <div style={{ flex: 1 }}>
                      <ActionBtn icon={stats?.batch.status === "active" ? <IconPause /> : <IconPlay />}
                        label={stats?.batch.status === "active" ? "Close batch" : "Resume"} disabled={busy} onClick={toggleStatus} />
                    </div>
                  </div>
                  <ActionBtn icon={<IconChat />} label="Batch Discussion" disabled={busy} onClick={() => router.push(`/admin/group-chat/${params.batchId}`)} />
                  <ActionBtn icon={<IconArchive />} label="Archive batch" disabled={busy} onClick={archiveBatch} />
                  <ActionBtn icon={<IconTrash />} label="Delete batch" tone="danger" disabled={busy} onClick={() => setDeleteOpen(true)} />
                </div>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", padding: "8px 0" }}>This batch is archived.</p>
            )}

          </>
        )}
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#111827",
          color: "#fff", padding: "10px 18px", borderRadius: 12, fontSize: 13, fontWeight: 600, zIndex: 60 }}>
          {toast}
        </div>
      )}

      {caseOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 55, display: "flex", alignItems: "center", justifyContent: "center", padding: 22 }}>
          <div style={{ background: "#fff", borderRadius: 20, padding: 22, width: "100%", maxWidth: 380 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Scale size={19} strokeWidth={2} color="#7c3aed" />
              <p style={{ fontSize: 16, fontWeight: 800, color: "#111827", margin: 0 }}>Court Case Number</p>
            </div>
            <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 14px" }}>
              Once the lawyer files {stats?.batch.name}&apos;s petition, just enter the
              case number — everything else (court, case type, year) is filled
              in for you. Leave it blank until then.
            </p>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", display: "block", marginBottom: 4 }}>Case Number *</label>
            <input autoFocus placeholder="e.g. 12345" value={caseForm.case_number}
              onChange={e => setCaseForm(f => ({ ...f, case_number: e.target.value }))}
              style={{ width: "100%", boxSizing: "border-box", border: "1.5px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "11px 12px", fontSize: 15, fontWeight: 700, marginBottom: 10 }} />
            <button type="button" onClick={() => setShowCaseAdvanced(v => !v)}
              style={{ border: 0, background: "none", color: "#6b7280", fontSize: 12, fontWeight: 700, textDecoration: "underline", cursor: "pointer", padding: 0, marginBottom: 10 }}>
              {showCaseAdvanced ? "Hide" : "Edit"} case type, year & link (auto-filled)
            </button>
            {showCaseAdvanced && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 4 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input placeholder="Case type (e.g. WP)" value={caseForm.case_type}
                    onChange={e => setCaseForm(f => ({ ...f, case_type: e.target.value }))}
                    style={{ flex: 1, border: "1.5px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "10px 12px", fontSize: 13 }} />
                  <input placeholder="Year (e.g. 2026)" value={caseForm.case_year}
                    onChange={e => setCaseForm(f => ({ ...f, case_year: e.target.value }))}
                    style={{ flex: 1, border: "1.5px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "10px 12px", fontSize: 13 }} />
                </div>
                <input placeholder="Status-check link (e.g. https://csis.tshc.gov.in/)" value={caseForm.case_status_url}
                  onChange={e => setCaseForm(f => ({ ...f, case_status_url: e.target.value }))}
                  style={{ width: "100%", boxSizing: "border-box", border: "1.5px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "10px 12px", fontSize: 13 }} />
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button onClick={() => setCaseOpen(false)} disabled={savingCase}
                style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: "1px solid #e5e7eb", background: "#fff", fontWeight: 700, fontSize: 14, color: "#374151" }}>
                Cancel
              </button>
              <button onClick={saveCaseDetails} disabled={savingCase}
                style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: "none", background: "#7c3aed", fontWeight: 700, fontSize: 14, color: "#fff", opacity: savingCase ? 0.7 : 1 }}>
                {savingCase ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 50, display: "flex", alignItems: "flex-end" }}>
          <div style={{ background: "#fff", borderRadius: "20px 20px 0 0", padding: 22, width: "100%" }}>
            <p style={{ fontSize: 15, fontWeight: 800, color: "#111827", margin: "0 0 6px" }}>Delete this batch?</p>
            <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 18px" }}>
              This permanently deletes &ldquo;{stats?.batch.name}&rdquo;. This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setDeleteOpen(false)} disabled={busy}
                style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: "1px solid #e5e7eb", background: "#fff", fontWeight: 700, fontSize: 14, color: "#374151" }}>
                Cancel
              </button>
              <button onClick={confirmDelete} disabled={busy}
                style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: "none", background: "#dc2626", fontWeight: 700, fontSize: 14, color: "#fff", opacity: busy ? 0.7 : 1 }}>
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.55}}`}</style>
    </div>
  );
}
