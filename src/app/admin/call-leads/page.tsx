"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Phone, MessageCircle, MapPin, User, HelpCircle, Zap, CalendarDays, Search, PhoneMissed } from "lucide-react";

type Lead = {
  id: string; caller_phone: string; caller_name: string | null;
  need: string | null; area: string | null; urgency: string | null;
  status: string; step: string; source: string | null;
  created_at: string; updated_at: string;
};

const STATUSES = ["New", "Contacted", "In progress", "Completed", "Lost"];

const STATUS_CLS: Record<string, string> = {
  "New": "bg-blue-100 text-blue-700",
  "Contacted": "bg-amber-100 text-amber-700",
  "In progress": "bg-indigo-100 text-indigo-700",
  "Completed": "bg-green-100 text-green-700",
  "Lost": "bg-gray-100 text-gray-500",
};

export default function AdminCallLeadsPage() {
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [tableMissing, setTableMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [simPhone, setSimPhone] = useState("");
  const [simBusy, setSimBusy] = useState(false);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  function showToast(msg: string, ok: boolean = true) { setToast({ msg, ok }); setTimeout(() => setToast(null), 4000); }

  function load() {
    setLoading(true);
    fetch("/api/admin/call-leads", { headers: h() })
      .then(async r => {
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.success) {
          showToast(`Load failed: ${r.status} ${j?.error ?? ""}`, false);
          setLeads([]);
        } else {
          setLeads(j.data?.leads ?? []);
          setTableMissing(!!j.data?.table_missing);
        }
        setLoading(false);
      })
      .catch(() => { showToast("Network error loading leads", false); setLoading(false); });
  }

  useEffect(() => { load(); }, []);

  async function setLeadStatus(lead: Lead, next: string) {
    const res = await fetch(`/api/admin/call-leads/${lead.id}`, {
      method: "PATCH",
      headers: { ...h(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    const j = await res.json().catch(() => null);
    if (j?.success) {
      setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status: next } : l));
      showToast(`Lead marked ${next}`);
    } else {
      showToast(j?.error ?? "Status update failed", false);
    }
  }

  async function simulate() {
    const phone = simPhone.replace(/\D/g, "").slice(-10);
    if (phone.length !== 10) { showToast("Enter a valid 10-digit number", false); return; }
    setSimBusy(true);
    try {
      const res = await fetch("/api/missed-call", {
        method: "POST",
        headers: { ...h(), "Content-Type": "application/json" },
        body: JSON.stringify({ caller_phone: phone, simulate: true }),
      });
      const j = await res.json().catch(() => null);
      if (j?.success && j.data?.created) showToast(`Missed call simulated — WhatsApp sent to ${phone}`);
      else if (j?.success && j.data?.deduped) showToast("That number already has an open lead (30-min dedupe)");
      else if (j?.success && j.data?.skipped) showToast("That number is a registered student/admin — no lead created");
      else showToast(j?.error ?? `Simulation failed (${res.status})`, false);
      if (j?.success) load();
    } catch {
      showToast("Network error — simulation failed", false);
    }
    setSimBusy(false);
  }

  const visible = leads.filter(l => {
    if (status && l.status !== status) return false;
    if (!q) return true;
    const hay = `${l.caller_name ?? ""} ${l.area ?? ""} ${l.need ?? ""} ${l.caller_phone}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  const countFor = (s: string) => leads.filter(l => l.status === s).length;

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      <div className="bg-blue-600 text-white px-4 pt-10 pb-4">
        <button onClick={() => router.back()} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.15)", border: "1.5px solid rgba(255,255,255,0.25)", borderRadius: 14, padding: "8px 16px 8px 10px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", marginBottom: 18, backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          Back
        </button>
        <div>
          <h1 className="text-xl font-bold">Call Leads</h1>
          <p className="text-sm opacity-80">{leads.length} total · missed calls turned into WhatsApp leads</p>
        </div>
      </div>

      <div className="px-4 mt-4 space-y-3">
        {tableMissing && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-2xl p-4">
            The <span className="font-mono font-semibold">missed_call_leads</span> table doesn&apos;t exist yet — paste migration
            <span className="font-mono font-semibold"> 0094_missed_call_leads.sql</span> in Supabase first. Leads will appear here after that.
          </div>
        )}

        {/* Simulate a missed call — tests the whole flow without the Android detector. */}
        <div className="bg-white rounded-2xl shadow-sm p-4">
          <p className="font-semibold text-sm flex items-center gap-1.5"><PhoneMissed size={15} strokeWidth={2} className="text-blue-600" /> Simulate a missed call</p>
          <p className="text-xs text-gray-400 mt-1">Enter a phone number — it gets the “Sorry we missed your call” WhatsApp and the lead chat starts.</p>
          <div className="flex gap-2 mt-3">
            <input value={simPhone} onChange={e => setSimPhone(e.target.value)} inputMode="numeric" placeholder="Caller phone (10-digit)"
              className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-200" />
            <button onClick={simulate} disabled={simBusy}
              className="bg-blue-600 text-white text-sm font-semibold px-4 rounded-xl disabled:opacity-60">
              {simBusy ? "Sending…" : "Simulate"}
            </button>
          </div>
        </div>

        <div className="relative">
          <Search size={15} strokeWidth={2} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, area, need, number"
            className="w-full text-sm bg-white border border-gray-200 rounded-xl pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-200" />
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          <button onClick={() => setStatus("")}
            className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full ${!status ? "bg-blue-600 text-white" : "bg-white text-gray-500 border border-gray-200"}`}>
            All ({leads.length})
          </button>
          {STATUSES.map(s => (
            <button key={s} onClick={() => setStatus(s)}
              className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full ${status === s ? "bg-blue-600 text-white" : "bg-white text-gray-500 border border-gray-200"}`}>
              {s} ({countFor(s)})
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 text-center py-10">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-10">No leads found</p>
        ) : visible.map((l, idx) => (
          <div key={l.id} className="bg-white rounded-2xl shadow-sm p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-sm">
                  <span className="text-gray-300 font-normal mr-1.5 tabular-nums">{idx + 1}.</span>
                  {l.caller_name ?? "Unknown caller"}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">{l.caller_phone} · {new Date(l.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${(STATUS_CLS[l.status] ?? STATUS_CLS.New)}`}>{l.status}</span>
            </div>

            <div className="mt-2.5 space-y-1 text-xs text-gray-500">
              {l.need && <div className="flex items-center gap-2"><HelpCircle size={12} strokeWidth={2} className="w-4 text-center text-gray-400" /><span>{l.need}</span></div>}
              {l.area && <div className="flex items-center gap-2"><MapPin size={12} strokeWidth={2} className="w-4 text-center text-gray-400" /><span>{l.area}</span></div>}
              {l.urgency && <div className="flex items-center gap-2"><Zap size={12} strokeWidth={2} className="w-4 text-center text-gray-400" /><span>{l.urgency}</span></div>}
              {l.step !== "done" && <div className="flex items-center gap-2"><User size={12} strokeWidth={2} className="w-4 text-center text-gray-400" /><span>Collecting… waiting for: {l.step}</span></div>}
              <div className="flex items-center gap-2"><CalendarDays size={12} strokeWidth={2} className="w-4 text-center text-gray-400" /><span>{new Date(l.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span></div>
            </div>

            <div className="flex gap-2 mt-3">
              <a href={`tel:+91${l.caller_phone}`} className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-blue-50 text-blue-600 py-2 rounded-xl font-medium">
                <Phone size={13} strokeWidth={2} /> Call
              </a>
              <a href={`https://wa.me/91${l.caller_phone}`} target="_blank" rel="noopener noreferrer" className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-green-50 text-green-600 py-2 rounded-xl font-medium">
                <MessageCircle size={13} strokeWidth={2} /> WhatsApp
              </a>
              <select value={l.status} onChange={e => setLeadStatus(l, e.target.value)} aria-label="Lead status"
                className="flex-1 text-sm bg-gray-50 text-gray-600 py-2 px-2 rounded-xl font-medium focus:outline-none">
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>

      {toast && (
        <div className={`fixed left-4 right-4 bottom-6 z-50 text-sm font-medium text-white rounded-2xl px-4 py-3 shadow-lg ${toast.ok ? "bg-gray-900" : "bg-red-600"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
