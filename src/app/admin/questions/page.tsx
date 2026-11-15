"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCw, CheckCircle2, HelpCircle } from "lucide-react";

interface QueueQuestion {
  id: string;
  shortId: number | null;
  question: string;
  occurrences: number;
  phone: string | null;
  lastSeenAt: string | null;
}
interface QuestionCluster {
  ids: string[];
  totalOccurrences: number;
  questions: QueueQuestion[];
}

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export default function QuestionsPage() {
  const router = useRouter();
  const [clusters, setClusters] = useState<QuestionCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Per-cluster (keyed by representative question id) answer text + busy flag.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState("");

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  function load() {
    setLoading(true);
    setError("");
    fetch("/api/admin/questions", { headers: h(), cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) { setError(j.error ?? "Failed to load"); setLoading(false); return; }
        setClusters(j.data?.clusters ?? []);
        setLoading(false);
      })
      .catch((e) => { setError("Network error — " + e.message); setLoading(false); });
  }

  useEffect(() => {
    const token = localStorage.getItem("sp_token");
    if (!token) { router.replace("/"); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function answer(cluster: QuestionCluster) {
    const key = cluster.questions[0].id;
    const text = (drafts[key] ?? "").trim();
    if (!text) { setToast("Type an answer first."); return; }
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const res = await fetch("/api/admin/questions", {
        method: "POST",
        headers: { ...h(), "Content-Type": "application/json" },
        body: JSON.stringify({ ids: cluster.ids, answer: text }),
      });
      const j = await res.json();
      if (!j.success) { setToast(j.error ?? "Failed to save"); setBusy((b) => ({ ...b, [key]: false })); return; }
      const notified = j.data?.notified ?? 0;
      const answered = j.data?.answered ?? cluster.ids.length;
      setToast(`Saved as FAQ · ${answered} question${answered === 1 ? "" : "s"} closed · ${notified} student${notified === 1 ? "" : "s"} notified`);
      // Drop the answered cluster from view + clear its draft.
      setClusters((cs) => cs.filter((c) => c.questions[0].id !== key));
      setDrafts((d) => { const n = { ...d }; delete n[key]; return n; });
    } catch (e) {
      setToast("Network error — " + (e as Error).message);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  const totalPending = clusters.reduce((s, c) => s + c.totalOccurrences, 0);

  return (
    <div style={{ minHeight: "100vh", background: "#f8f9fa", paddingBottom: 60 }}>
      {/* Header */}
      <div style={{ background: "linear-gradient(135deg,#0d9488,#0f766e)", padding: "48px 16px 20px" }}>
        <button onClick={() => router.back()}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.15)", border: "1.5px solid rgba(255,255,255,0.25)", borderRadius: 14, padding: "8px 14px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 16 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          Back
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ color: "#fff", fontSize: 20, fontWeight: 700, margin: 0 }}>Student Questions</h1>
            <p style={{ color: "rgba(255,255,255,0.8)", fontSize: 12, margin: "4px 0 0" }}>
              Answer once — creates an FAQ & notifies every asker
            </p>
          </div>
          <button onClick={load}
            style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 12, padding: "8px 12px", color: "#fff", cursor: "pointer" }}><RotateCw size={16} strokeWidth={2} /></button>
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
        ) : clusters.length === 0 ? (
          <div style={{ textAlign: "center", padding: "56px 16px" }}>
            <CheckCircle2 size={34} strokeWidth={1.6} color="#a7f3d0" style={{ marginBottom: 8 }} />
            <p style={{ fontSize: 15, fontWeight: 700, color: "#111827", margin: 0 }}>All caught up</p>
            <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>No pending student questions right now.</p>
          </div>
        ) : (
          <>
            <p style={{ fontSize: 11, fontWeight: 800, color: "#9ca3af", letterSpacing: 1, marginBottom: 10 }}>
              {clusters.length} TOPIC{clusters.length === 1 ? "" : "S"} · {totalPending} QUESTION{totalPending === 1 ? "" : "S"}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {clusters.map((c) => {
                const rep = c.questions[0];
                const others = c.questions.slice(1);
                const key = rep.id;
                return (
                  <div key={key} style={{ background: "#fff", borderRadius: 18, padding: "16px", boxShadow: "0 1px 6px rgba(0,0,0,0.06)" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                      <span style={{ width: 34, height: 34, borderRadius: 10, background: "#ccfbf1", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><HelpCircle size={16} strokeWidth={2} color="#0d9488" /></span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 14, fontWeight: 800, color: "#111827", margin: 0, lineHeight: 1.35 }}>{rep.question}</p>
                        <p style={{ fontSize: 11, color: "#9ca3af", margin: "4px 0 0" }}>
                          {rep.shortId != null ? `UQ-${String(rep.shortId).padStart(3, "0")} · ` : ""}
                          asked {c.totalOccurrences}×{others.length ? ` · ${others.length} similar` : ""} · {timeAgo(rep.lastSeenAt)}
                        </p>
                      </div>
                    </div>

                    {others.length > 0 && (
                      <div style={{ background: "#f9fafb", borderRadius: 12, padding: "8px 12px", marginBottom: 10 }}>
                        <p style={{ fontSize: 10, fontWeight: 800, color: "#9ca3af", letterSpacing: 0.5, margin: "0 0 4px" }}>ALSO ASKED AS</p>
                        {others.map((o) => (
                          <p key={o.id} style={{ fontSize: 12, color: "#6b7280", margin: "3px 0" }}>• {o.question}</p>
                        ))}
                      </div>
                    )}

                    <textarea
                      value={drafts[key] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                      placeholder="Type the answer — it will be saved as an FAQ and sent to every student who asked."
                      rows={3}
                      style={{ width: "100%", boxSizing: "border-box", border: "1.5px solid #e5e7eb", borderRadius: 12, padding: "10px 12px", fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none", color: "#111827" }}
                    />
                    <button
                      onClick={() => answer(c)}
                      disabled={!!busy[key]}
                      style={{ marginTop: 10, width: "100%", background: busy[key] ? "#94a3b8" : "linear-gradient(135deg,#0d9488,#0f766e)", color: "#fff", border: "none", borderRadius: 12, padding: "12px 0", fontSize: 14, fontWeight: 800, cursor: busy[key] ? "default" : "pointer" }}>
                      {busy[key] ? "Saving…" : `Answer & create FAQ${c.ids.length > 1 ? ` (${c.ids.length})` : ""}`}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {toast && (
        <div
          onClick={() => setToast("")}
          style={{ position: "fixed", left: 16, right: 16, bottom: 20, background: "#111827", color: "#fff", borderRadius: 14, padding: "13px 16px", fontSize: 13, fontWeight: 600, boxShadow: "0 8px 32px rgba(0,0,0,0.3)", zIndex: 80, cursor: "pointer" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
