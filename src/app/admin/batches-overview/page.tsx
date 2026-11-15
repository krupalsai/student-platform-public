"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Package } from "lucide-react";
import { paidLine } from "@/lib/batch-paid-line";

interface Batch {
  id: string; name: string; slug: string; college: string; status: string;
  fee_amount: number; student_count: number;
  /** Finished registrations with an approved payment; null when the read failed. */
  paid_count: number | null;
  /** Everyone in the batch without an approved payment (finished or not); null when the read failed. */
  not_paid_count: number | null;
}

const COLLEGE_THEME: Record<string, { color: string; bg: string; border: string }> = {
  GNIT:  { color: "#ef4444", bg: "#fef2f2", border: "#fecaca" },
  GNITC: { color: "#475569", bg: "#f1f5f9", border: "#cbd5e1" },
};

function Skel({ h = 90 }: { h?: number }) {
  return <div style={{ height: h, borderRadius: 18, background: "rgba(0,0,0,0.06)", animation: "pulse 1.4s ease infinite" }} />;
}

function BatchesOverviewInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const college = searchParams.get("college") ?? "GNIT";
  const theme = COLLEGE_THEME[college] ?? COLLEGE_THEME.GNIT;

  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  useEffect(() => {
    setLoading(true);
    // no-store: student_count changes as registrations complete — a stale
    // cached response here was the same class of bug as the batch-detail
    // page (see that page's loadStats comment), just on the list view.
    fetch(`/api/admin/batches?college=${college}`, { headers: h(), cache: "no-store" })
      .then(r => r.json())
      .then(j => {
        const list: Batch[] = j.success ? (j.data ?? []) : [];
        // Sort by the trailing number in the batch name ("Batch 1", "Batch 2", ...)
        // so the list reads in the order students expect, not by creation date.
        const num = (name: string) => { const m = name.match(/(\d+)\s*$/); return m ? parseInt(m[1], 10) : Infinity; };
        list.sort((a, b) => num(a.name) - num(b.name) || a.name.localeCompare(b.name));
        setBatches(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [college]);

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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <button onClick={() => router.push("/admin")} style={{
            display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.18)",
            border: "1.5px solid rgba(255,255,255,0.3)", borderRadius: 14, padding: "8px 16px 8px 10px",
            color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            Back
          </button>

          {/* + New Batch — pre-selects this college, per the reference layout */}
          <button onClick={() => router.push(`/admin/batches?new=1&college=${college}`)} style={{
            display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.22)",
            border: "1.5px solid rgba(255,255,255,0.4)", borderRadius: 14, padding: "8px 16px 8px 12px",
            color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Batch
          </button>
        </div>

        <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 11, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", margin: 0 }}>College</p>
        <h1 style={{ color: "#fff", fontSize: 30, fontWeight: 900, margin: "4px 0 0" }}>{college}</h1>
        <p style={{ color: "rgba(255,255,255,0.85)", fontSize: 13, margin: "6px 0 0" }}>Select a batch to view its students & payments</p>
      </div>

      <div style={{ padding: "18px 16px 40px", display: "flex", flexDirection: "column", gap: 12 }}>
        {loading ? (
          <>
            <Skel /><Skel /><Skel />
          </>
        ) : batches.length === 0 ? (
          <div style={{ background: "#fff", borderRadius: 18, padding: "32px 20px", textAlign: "center" }}>
            <Package size={28} strokeWidth={1.6} color="#cbd5e1" style={{ marginBottom: 8 }} />
            <p style={{ fontWeight: 700, color: "#374151" }}>No batches yet for {college}</p>
            <button onClick={() => router.push("/admin/batches")} style={{
              marginTop: 14, background: theme.color, color: "#fff", border: "none",
              borderRadius: 12, padding: "10px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer",
            }}>Create a batch</button>
          </div>
        ) : (
          batches.map((b, idx) => (
            <button key={b.id}
              onClick={() => router.push(`/admin/batches-overview/${b.id}`)}
              style={{
                background: "#fff", border: `1.5px solid ${theme.border}`, borderRadius: 18,
                padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between",
                cursor: "pointer", textAlign: "left", boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
                opacity: mounted ? 1 : 0, transform: mounted ? "translateY(0)" : "translateY(10px)",
                transition: `opacity 0.3s ease ${idx * 0.05}s, transform 0.3s cubic-bezier(0.16,1,0.3,1) ${idx * 0.05}s`,
              }}>
              <div>
                <p style={{ fontWeight: 800, fontSize: 15, color: "#111827", margin: 0 }}>{b.name}</p>
                <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>
                  {b.student_count} student{b.student_count !== 1 ? "s" : ""} · ₹{Number(b.fee_amount).toLocaleString("en-IN")} fee
                </p>
                {(() => {
                  const line = paidLine(b);
                  return line ? <p style={{ fontSize: 12, fontWeight: 600, color: line.color, margin: "3px 0 0" }}>{line.text}</p> : null;
                })()}
                <span style={{
                  display: "inline-block", marginTop: 6, fontSize: 10, fontWeight: 700,
                  padding: "2px 8px", borderRadius: 20,
                  background: b.status === "active" ? "#dcfce7" : "#f3f4f6",
                  color: b.status === "active" ? "#166534" : "#6b7280",
                }}>{b.status}</span>
              </div>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={theme.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          ))
        )}
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.55}}`}</style>
    </div>
  );
}

export default function BatchesOverviewPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#f8fafc" }} />}>
      <BatchesOverviewInner />
    </Suspense>
  );
}
