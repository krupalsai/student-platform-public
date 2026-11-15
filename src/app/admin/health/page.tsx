"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";

interface Metric {
  label: string;
  score: number;
  detail: string;
  status: "ok" | "warn" | "error";
  rows?: { key: string; value: string | number }[];
}

function ScoreBar({ score, status }: { score: number; status: string }) {
  const color = status === "ok" ? "bg-green-500" : status === "warn" ? "bg-amber-400" : "bg-red-500";
  const textColor = status === "ok" ? "text-green-600" : status === "warn" ? "text-amber-600" : "text-red-600";
  return (
    <div className="flex items-center gap-3 flex-1">
      <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full transition-all duration-500 ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-sm font-bold w-10 text-right ${textColor}`}>{score}</span>
    </div>
  );
}

function DrillDown({ rows }: { rows: { key: string; value: string | number }[] }) {
  return (
    <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
      {rows.map(r => (
        <div key={r.key} className="flex justify-between items-center">
          <span className="text-xs text-gray-400">{r.key}</span>
          <span className="text-xs font-semibold text-gray-700">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function HealthPage() {
  const router = useRouter();
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    fetch("/api/admin/health", { headers: h() })
      .then(r => r.json())
      .then(j => { if (j.success) setMetrics(j.data); setLoading(false); setRefreshing(false); })
      .catch(() => { setLoading(false); setRefreshing(false); });
  }

  useEffect(() => { load(); }, []);

  const overall = metrics.length > 0 ? Math.round(metrics.reduce((s, m) => s + m.score, 0) / metrics.length) : 0;
  const overallStatus = overall >= 85 ? "ok" : overall >= 60 ? "warn" : "error";
  const statusColor = overallStatus === "ok" ? "bg-green-500" : overallStatus === "warn" ? "bg-amber-400" : "bg-red-500";

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      <div className="bg-blue-600 text-white px-4 pt-10 pb-5">
        <button onClick={() => router.back()} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.15)", border:"1.5px solid rgba(255,255,255,0.25)", borderRadius:14, padding:"8px 16px 8px 10px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", marginBottom:18, backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div className="flex justify-between items-center">
          <h1 className="text-xl font-bold">System Health</h1>
          <button onClick={() => load(true)} disabled={refreshing}
            className="flex items-center gap-1.5 bg-white/20 px-3 py-1.5 rounded-full text-sm font-medium disabled:opacity-60">
            {refreshing ? "…" : <><RotateCw size={13} strokeWidth={2} /> Refresh</>}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="px-4 mt-4 space-y-3">
          {[1,2,3,4,5].map(i => (
            <div key={i} className="bg-white rounded-2xl p-4 shadow-sm animate-pulse h-16" />
          ))}
        </div>
      ) : (
        <div className="px-4 mt-4 space-y-3">
          {/* Overall score */}
          <div className="bg-white rounded-2xl p-4 shadow-sm flex items-center gap-4">
            <div className="text-4xl font-black text-gray-800 w-16 text-center">{overall}</div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
                <span className="font-semibold text-sm">Overall Health</span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
                <div
                  className={`h-3 rounded-full transition-all duration-700 ${overallStatus === "ok" ? "bg-green-500" : overallStatus === "warn" ? "bg-amber-400" : "bg-red-500"}`}
                  style={{ width: `${overall}%` }}
                />
              </div>
            </div>
          </div>

          <p className="text-xs text-gray-400 px-1">Tap any card to see details</p>

          {/* Per-metric cards — tappable */}
          {metrics.map(m => {
            const isOpen = expanded === m.label;
            return (
              <button
                key={m.label}
                onClick={() => setExpanded(isOpen ? null : m.label)}
                className={`w-full bg-white rounded-2xl p-4 shadow-sm text-left transition-all
                  ${m.status === "error" ? "border border-red-200" : m.status === "warn" ? "border border-amber-200" : ""}
                  active:scale-[0.98]`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-sm font-semibold text-gray-800 w-24 text-left">{m.label}</span>
                  <ScoreBar score={m.score} status={m.status} />
                  <span className="text-gray-300 text-sm">{isOpen ? "▲" : "▼"}</span>
                </div>
                {m.detail && (
                  <p className="text-xs text-gray-400 ml-[6rem]">{m.detail}</p>
                )}
                {isOpen && m.rows && m.rows.length > 0 && (
                  <DrillDown rows={m.rows} />
                )}
              </button>
            );
          })}

        </div>
      )}
    </div>
  );
}
