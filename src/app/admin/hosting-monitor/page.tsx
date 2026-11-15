"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, X, Sparkles } from "lucide-react";

interface DeploymentInfo {
  provider:   "vercel" | "netlify";
  status:     "healthy" | "degraded" | "unknown";
  url:        string;
  lastDeploy: string | null;
  lastCommit: string | null;
  buildState: string | null;
  isPrimary:  boolean;
  usagePct:   number | null;
  usageLabel: string | null;
  customDomain: string | null;
}
interface HostingStatus {
  vercel:      DeploymentInfo;
  netlify:     DeploymentInfo;
  activeHost:  "vercel" | "netlify";
  checkedAt:   string;
  canOneClick: boolean;
  switchSteps: string[];
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const IconVercel = () => (
  <svg width="18" height="18" viewBox="0 0 76 65" fill="currentColor">
    <path d="M37.5274 0L75.0548 65H0L37.5274 0Z"/>
  </svg>
);
const IconNetlify = () => (
  <svg width="18" height="18" viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="8" fill="#00AD9F"/>
    <path d="M22 10l8 10-8 10V10zM18 10l-8 10 8 10V10z" fill="white" opacity="0.8"/>
  </svg>
);
const IconRefresh = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);
const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);
const IconWarn = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);
const IconUnknown = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);
const IconCopy = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);
const IconExternal = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "Just now";
}

function StatusBadge({ status }: { status: DeploymentInfo["status"] }) {
  const map = {
    healthy:  { bg: "bg-emerald-500", text: "Healthy",  Icon: IconCheck  },
    degraded: { bg: "bg-rose-500",    text: "Degraded", Icon: IconWarn   },
    unknown:  { bg: "bg-gray-400",    text: "Unknown",  Icon: IconUnknown },
  };
  const { bg, text, Icon } = map[status];
  return (
    <span className={`${bg} text-white text-[11px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1.5`}>
      <Icon />{text}
    </span>
  );
}

function UsageBar({ pct, label }: { pct: number | null; label: string | null }) {
  if (pct === null) return <p className="text-xs text-gray-400 mt-2">Usage data unavailable</p>;
  const color = pct >= 80 ? "bg-rose-500" : pct >= 60 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="mt-3">
      <div className="flex justify-between items-center mb-1">
        <p className="text-xs text-gray-500 font-medium">{label ?? "Usage"}</p>
        <p className={`text-xs font-bold ${pct >= 80 ? "text-rose-600" : pct >= 60 ? "text-amber-600" : "text-emerald-600"}`}>{pct}%</p>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {pct >= 80 && (
        <p className="text-xs text-rose-500 mt-1 font-medium flex items-center gap-1"><AlertTriangle size={12} strokeWidth={2} /> Approaching limit — consider switching standby</p>
      )}
    </div>
  );
}

function ProviderCard({ info, isActive }: { info: DeploymentInfo; isActive: boolean }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(info.url).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  }
  return (
    <div className={`bg-white rounded-2xl shadow-sm overflow-hidden ${isActive ? "border-2 border-blue-500" : "border border-gray-100"}`}>
      {isActive && <div className="h-1 bg-blue-500" />}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <span className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${info.provider === "vercel" ? "bg-black text-white" : "bg-teal-500 text-white"}`}>
              {info.provider === "vercel" ? <IconVercel /> : <IconNetlify />}
            </span>
            <div>
              <p className="font-bold text-gray-900 text-sm capitalize">{info.provider}</p>
              <p className="text-[10px] text-gray-400 font-medium">
                {info.isPrimary ? "Primary" : "Standby"}
                {isActive && <span className="ml-1.5 text-blue-600 font-bold">● Active</span>}
              </p>
            </div>
          </div>
          <StatusBadge status={info.status} />
        </div>

        {/* URL row */}
        <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2 mb-3">
          <p className="text-xs text-gray-600 flex-1 truncate font-mono">{info.url}</p>
          <button onClick={copy} className="text-gray-400 active:scale-95 transition-transform flex-shrink-0">
            {copied ? <span className="text-emerald-500 text-[10px] font-bold">Copied!</span> : <IconCopy />}
          </button>
          <a href={info.url} target="_blank" rel="noopener noreferrer" className="text-gray-400 active:scale-95 transition-transform flex-shrink-0">
            <IconExternal />
          </a>
        </div>

        {/* Meta rows */}
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <span className="text-xs text-gray-400">Last deploy</span>
            <span className="text-xs font-semibold text-gray-700">{timeAgo(info.lastDeploy)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-xs text-gray-400">Build state</span>
            <span className="text-xs font-semibold text-gray-700 truncate max-w-[160px] text-right">{info.buildState ?? "—"}</span>
          </div>
          {info.lastCommit && (
            <div className="flex justify-between gap-2">
              <span className="text-xs text-gray-400 flex-shrink-0">Last commit</span>
              <span className="text-xs font-semibold text-gray-600 truncate text-right">{info.lastCommit}</span>
            </div>
          )}
        </div>

        <UsageBar pct={info.usagePct} label={info.usageLabel} />
      </div>
    </div>
  );
}

// ── Switch Modal ──────────────────────────────────────────────────────────────
function SwitchModal({ steps, canOneClick, netlifyUrl, onClose }: {
  steps: string[]; canOneClick: boolean; netlifyUrl: string; onClose: () => void;
}) {
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const allChecked = steps.length > 0 && steps.every((_, i) => checked[i]);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={onClose}>
      <div className="bg-white w-full rounded-t-3xl max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white px-5 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <h2 className="font-black text-gray-900 text-lg">Switch to Netlify</h2>
            <button onClick={onClose} className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500"><X size={15} strokeWidth={2} /></button>
          </div>
          {canOneClick
            ? <p className="text-xs text-emerald-600 font-semibold mt-1">Custom domain detected — one-click cutover available</p>
            : <p className="text-xs text-amber-600 font-semibold mt-1">No custom domain — follow manual steps below</p>
          }
        </div>

        <div className="px-5 py-4 space-y-3">
          {!canOneClick && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
              <p className="text-xs font-bold text-amber-800 mb-1">Why no instant switch?</p>
              <p className="text-xs text-amber-700 leading-relaxed">
                Students access the app via Telegram using the Vercel URL. Without a custom domain,
                there is no central redirect to flip. You must manually update the URL in BotFather
                and inform students. When you add a custom domain later, this becomes one-click.
              </p>
            </div>
          )}

          {/* Steps checklist */}
          <div className="space-y-2">
            {steps.map((step, i) => (
              <button key={i} onClick={() => setChecked(c => ({ ...c, [i]: !c[i] }))}
                className={`w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-colors
                  ${checked[i] ? "bg-emerald-50 border-emerald-200" : "bg-gray-50 border-gray-100"}`}>
                <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors
                  ${checked[i] ? "bg-emerald-500 border-emerald-500 text-white" : "border-gray-300"}`}>
                  {checked[i] && <IconCheck />}
                </span>
                <p className={`text-xs font-medium leading-relaxed ${checked[i] ? "text-emerald-700 line-through" : "text-gray-700"}`}>
                  {step}
                </p>
              </button>
            ))}
          </div>

          {/* Netlify URL highlight */}
          <div className="bg-gray-900 rounded-2xl p-4">
            <p className="text-xs text-gray-400 mb-1 font-medium">Netlify standby URL</p>
            <p className="text-sm font-mono text-white break-all">{netlifyUrl}</p>
          </div>

          {/* Future upgrade note */}
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
            <p className="text-xs font-bold text-blue-800 mb-1 flex items-center gap-1.5"><Sparkles size={12} strokeWidth={2} /> Upgrade path</p>
            <p className="text-xs text-blue-700 leading-relaxed">
              Add a custom domain (e.g. <code className="bg-blue-100 px-1 rounded">app.studentplatform.in</code>) and point it to Vercel.
              Once set, the <code className="bg-blue-100 px-1 rounded">CUSTOM_DOMAIN</code> env var will
              unlock true one-click DNS cutover between Vercel and Netlify from this panel.
            </p>
          </div>

          {allChecked && (
            <div className="bg-emerald-500 rounded-2xl p-4 text-center">
              <p className="text-white font-bold text-sm">All steps completed</p>
              <p className="text-white/80 text-xs mt-0.5">Monitor Netlify for 30 min before marking migration complete</p>
            </div>
          )}
        </div>

        <div className="px-5 pb-8">
          <button onClick={onClose}
            className="w-full bg-gray-100 text-gray-700 font-bold py-3.5 rounded-2xl text-sm active:scale-[0.98] transition-transform">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function HostingMonitorPage() {
  const router = useRouter();
  const [data,       setData]       = useState<HostingStatus | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    fetch("/api/admin/hosting", { headers: h() })
      .then(r => r.json())
      .then(j => { if (j.success) setData(j.data); })
      .finally(() => { setLoading(false); setRefreshing(false); });
  }

  useEffect(() => { load(); }, []);

  const isVercelActive  = data?.activeHost === "vercel";
  const isNetlifyActive = data?.activeHost === "netlify";
  const bothHealthy     = data?.vercel.status === "healthy" && data?.netlify.status === "healthy";
  const anyDegraded     = data?.vercel.status === "degraded" || data?.netlify.status === "degraded";

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      {/* Header */}
      <div className="relative overflow-hidden px-5 pt-10 pb-6"
        style={{ background: "linear-gradient(135deg, #1e1b4b 0%, #0a3d8f 50%, #4338ca 100%)" }}>
        <div className="absolute -top-8 -right-8 w-40 h-40 rounded-full bg-white/5" />
        <div className="relative flex items-center gap-3 mb-4">
          <button onClick={() => router.back()}
            className="w-9 h-9 rounded-2xl bg-white/20 border border-white/30 flex items-center justify-center flex-shrink-0 active:scale-95 transition-transform">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <div className="flex-1">
            <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest">Admin</p>
            <h1 className="text-white font-black text-xl">Hosting Monitor</h1>
          </div>
          <button onClick={() => load(true)} disabled={refreshing}
            className={`w-9 h-9 rounded-2xl bg-white/20 border border-white/30 flex items-center justify-center active:scale-95 transition-all ${refreshing ? "animate-spin" : ""}`}>
            <IconRefresh />
          </button>
        </div>

        {/* Overall status pill */}
        {!loading && data && (
          <div className={`inline-flex items-center gap-2 rounded-full px-4 py-2 border text-xs font-bold
            ${anyDegraded
              ? "bg-rose-500/20 border-rose-400/40 text-rose-200"
              : bothHealthy
              ? "bg-emerald-500/20 border-emerald-400/40 text-emerald-200"
              : "bg-amber-500/20 border-amber-400/40 text-amber-200"
            }`}>
            <span className={`w-2 h-2 rounded-full ${anyDegraded ? "bg-rose-400" : bothHealthy ? "bg-emerald-400" : "bg-amber-400"}`} />
            {anyDegraded ? "Degraded deployment detected" : bothHealthy ? "Both deployments healthy" : "Status partially unknown"}
            <span className="opacity-60 ml-1">· {data.checkedAt ? timeAgo(data.checkedAt) : ""}</span>
          </div>
        )}
      </div>

      <div className="px-4 pt-5 space-y-4">
        {loading ? (
          [1, 2].map(i => <div key={i} className="bg-white rounded-2xl h-52 animate-pulse" />)
        ) : !data ? (
          <div className="bg-white rounded-2xl p-8 text-center">
            <p className="text-gray-500 font-semibold text-sm">Could not load hosting data</p>
            <button onClick={() => load()} className="mt-3 text-blue-600 text-sm font-bold">Retry</button>
          </div>
        ) : (
          <>
            <ProviderCard info={data.vercel}  isActive={isVercelActive}  />
            <ProviderCard info={data.netlify} isActive={isNetlifyActive} />

            {/* Switch section */}
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <div className="flex items-start gap-3 mb-4">
                <span className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center flex-shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                    <polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                  </svg>
                </span>
                <div>
                  <p className="font-bold text-gray-900 text-sm">Switch to Netlify Standby</p>
                  <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                    {data.canOneClick
                      ? "Custom domain configured — one-click cutover available."
                      : "No custom domain. Switching requires manual steps in BotFather and student notification."}
                  </p>
                </div>
              </div>
              <button onClick={() => setShowSwitch(true)}
                className="w-full py-3.5 rounded-2xl font-bold text-sm active:scale-[0.98] transition-transform text-white"
                style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}>
                {data.canOneClick ? "Switch to Netlify →" : "View Migration Steps →"}
              </button>
            </div>

            {/* Last checked */}
            <p className="text-center text-xs text-gray-400 pb-2">
              Last checked {timeAgo(data.checkedAt)} · Alerts sent to Telegram if degraded
            </p>
          </>
        )}
      </div>

      {showSwitch && data && (
        <SwitchModal
          steps={data.switchSteps}
          canOneClick={data.canOneClick}
          netlifyUrl={data.netlify.url}
          onClose={() => setShowSwitch(false)}
        />
      )}
    </div>
  );
}
