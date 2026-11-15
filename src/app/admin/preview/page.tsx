"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import RouteMap from "@/components/RouteMap";
import { FileEdit, AlertTriangle, Map, LayoutDashboard, ChevronRight } from "lucide-react";

interface Batch { id: string; name: string; slug: string; college: string; status: string; }
interface StudentOption { id: string; full_name: string; roll_number: string | null; }

function h() {
  const t = typeof window !== "undefined" ? localStorage.getItem("sp_token") : null;
  return { Authorization: `Bearer ${t ?? ""}` };
}

type PreviewTab = "register" | "dashboard" | "routemap";

const TAB_META: Record<PreviewTab, { label: string; desc: string; menuDesc: string; Icon: typeof FileEdit }> = {
  register: {
    label: "Registration Form",
    Icon: FileEdit,
    menuDesc: "The real, live page a student sees opening a batch's link",
    desc: "This is the real, live registration page — not a mockup. Pick a batch below to preview it as a student opening that batch's link would see it. Nothing you do here is visible to students or affects real data unless you actually submit a payment.",
  },
  dashboard: {
    label: "Student Dashboard",
    Icon: LayoutDashboard,
    menuDesc: "How the app looks and works after registration",
    desc: "Open the real student dashboard for one registered student. This is an interactive student session, not a mockup or read-only screenshot. Actions use that student's account and are subject to the normal server-side permissions.",
  },
  routemap: {
    label: "Certificate Route Map",
    Icon: Map,
    menuDesc: "The same component students see once payment is approved",
    desc: "The exact same component students see on their dashboard after payment is approved.",
  },
};

export default function AdminPreviewPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<PreviewTab | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  // Unfiltered (any status) — the Registration Form/Route Map pickers only
  // make sense for a currently-active batch (that's the live link a student
  // would actually open), but the Student Dashboard picker previews a REAL
  // already-registered student, and a batch that's since closed (e.g. GNIT
  // Batch 1, 24 completed students) still has those students on it. Filtering
  // this one to active-only silently hid every closed batch's roster.
  const [allBatches, setAllBatches] = useState<Batch[]>([]);
  // Fetched, not hardcoded to GNIT/GNITC — an admin previewing as a student
  // could otherwise never pick a third college's batch. Same trap as items
  // #101/#107/#114/#118/#125. Note the colleges endpoint only returns
  // ACTIVE colleges, so the picker list below is derived from the fetched
  // batches instead: every college with at least one batch (any status)
  // appears — including BIET, which is inactive but has a live batch — and
  // colleges with no batches never appear.
  const [colleges, setColleges] = useState<{ id: string; name: string }[]>([
    { id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" },
  ]);
  const pickerColleges = useMemo(() => {
    if (allBatches.length === 0) return colleges; // fallback until batches load
    const seen = new Set<string>();
    const list: { id: string; name: string }[] = [];
    for (const b of allBatches) {
      if (!seen.has(b.college)) {
        seen.add(b.college);
        list.push({ id: b.college, name: colleges.find(c => c.id === b.college)?.name ?? b.college });
      }
    }
    return list;
  }, [allBatches, colleges]);
  const [formCollege, setFormCollege] = useState<string>("GNIT");
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [routeCollege, setRouteCollege] = useState<string>("GNIT");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [dashCollege, setDashCollege] = useState<string>("GNIT");
  const [dashSlug, setDashSlug] = useState<string>("");
  const [dashStudents, setDashStudents] = useState<StudentOption[]>([]);
  const [dashStudentsLoading, setDashStudentsLoading] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [previewToken, setPreviewToken] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store", headers: h() })
      .then(r => r.json())
      .then(session => {
        if (!session.success || session.data?.role !== "super_admin") router.replace("/admin");
      })
      .catch(() => router.replace("/admin"));
  }, []);

  useEffect(() => {
    fetch("/api/admin/batches", { headers: h() })
      .then(async r => {
        const j = await r.json().catch(() => null);
        if (!r.ok) { setLoadError(j?.error ?? `Request failed (${r.status})`); setBatches([]); return; }
        if (!j?.success || !Array.isArray(j.data)) { setLoadError("Unexpected response from server"); setBatches([]); setAllBatches([]); return; }
        setBatches(j.data.filter((b: any) => b.status === "active"));
        setAllBatches(j.data);
      })
      .catch(err => { setLoadError(err?.message ?? "Network error while loading batches"); setBatches([]); setAllBatches([]); })
      .finally(() => setLoading(false));
    fetch("/api/settings/colleges").then(r => r.json()).then(j => {
      if (Array.isArray(j.data) && j.data.length) setColleges(j.data);
    }).catch(() => {});
  }, []);

  const collegeBatches = batches.filter(b => b.college === formCollege);
  useEffect(() => {
    setSelectedSlug(collegeBatches[0]?.slug ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formCollege, batches.length]);
  const selectedBatch = collegeBatches.find(b => b.slug === selectedSlug) ?? null;

  const dashCollegeBatches = allBatches.filter(b => b.college === dashCollege);
  useEffect(() => {
    setDashSlug(dashCollegeBatches[0]?.slug ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashCollege, allBatches.length]);
  const dashSelectedBatch = dashCollegeBatches.find(b => b.slug === dashSlug) ?? null;

  useEffect(() => {
    setSelectedStudentId("");
    setPreviewToken("");
    setPreviewError("");
    if (!dashSelectedBatch) { setDashStudents([]); return; }
    setDashStudentsLoading(true);
    fetch(`/api/admin/students?batch_id=${dashSelectedBatch.id}`, { headers: h() })
      .then(r => r.json())
      .then(j => {
        const list: StudentOption[] = j?.success
          ? (j.data?.students ?? []).filter((s: any) => s.is_profile_complete).map((s: any) => ({ id: s.id, full_name: s.full_name, roll_number: s.roll_number }))
          : [];
        setDashStudents(list);
      })
      .catch(() => setDashStudents([]))
      .finally(() => setDashStudentsLoading(false));
  }, [dashSelectedBatch?.id]);

  async function openDashboardPreview() {
    if (!selectedStudentId) return;
    setPreviewLoading(true);
    setPreviewError("");
    setPreviewToken("");
    try {
      const res = await fetch(`/api/admin/students/${selectedStudentId}/preview-session`, { method: "POST", headers: h() });
      const j = await res.json();
      if (!j.success) { setPreviewError(j.error ?? "Could not open preview."); return; }
      setPreviewToken(j.data.token);
    } catch { setPreviewError("Network error. Please try again."); }
    finally { setPreviewLoading(false); }
  }

  const appUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="min-h-screen bg-gray-50 pb-12">
      <div className="bg-blue-600 text-white px-4 pt-10 pb-5">
        <button
          onClick={() => activeTab ? setActiveTab(null) : router.back()}
          style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.15)", border:"1.5px solid rgba(255,255,255,0.25)", borderRadius:14, padding:"8px 16px 8px 10px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", marginBottom:18, backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          {activeTab ? "Back to options" : "Back"}
        </button>
        <h1 className="text-xl font-bold">{activeTab ? TAB_META[activeTab].label : "Student View Preview"}</h1>
        <p className="text-sm text-blue-100 mt-1">
          {activeTab ? TAB_META[activeTab].desc : "Pick what you want to preview — the exact real thing students see, not a mockup."}
        </p>
      </div>

      {activeTab === null && (
        <div className="px-4 mt-6 space-y-3">
          {(Object.keys(TAB_META) as PreviewTab[]).map(id => {
            const { label, menuDesc, Icon } = TAB_META[id];
            return (
              <button key={id} onClick={() => setActiveTab(id)} className="w-full bg-white rounded-2xl border border-gray-200 p-4 flex items-center gap-3 shadow-sm active:scale-[0.98] transition-transform text-left">
                <div className="w-11 h-11 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0"><Icon size={20} strokeWidth={2} className="text-blue-600" /></div>
                <div className="flex-1 min-w-0"><p className="font-bold text-gray-900 text-sm">{label}</p><p className="text-xs text-gray-400 mt-0.5">{menuDesc}</p></div>
                <ChevronRight size={18} strokeWidth={2} className="text-gray-300 flex-shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      {activeTab !== null && (
      <div className="px-4 mt-6">
        {activeTab === "register" && (
        <section>
          {loading ? <div className="rounded-2xl border border-gray-100 bg-white p-6 text-center text-sm text-gray-400">Loading batches…</div>
          : loadError ? <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"><AlertTriangle size={12} strokeWidth={2} className="inline mr-1" /> Could not load batches: {loadError}<br /><span className="text-xs text-red-500">Check that you're logged in as an admin and try refreshing.</span></div>
          : batches.length === 0 ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">No active batches yet — create one in Batches to preview the registration form.</div>
          : <>
              <select value={formCollege} onChange={e => setFormCollege(e.target.value)} className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm mb-3">{pickerColleges.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              {collegeBatches.length === 0 ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 mb-3">No active {formCollege} batches yet.</div> : <select value={selectedSlug} onChange={e => setSelectedSlug(e.target.value)} className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm mb-3">{collegeBatches.map(b => <option key={b.id} value={b.slug}>{b.name}</option>)}</select>}
              {selectedSlug && <div className="rounded-2xl border border-gray-200 overflow-hidden bg-white shadow-sm"><div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100"><span className="text-xs text-gray-400 font-mono truncate">/register?batch={selectedSlug}</span><a href={`${appUrl}/register?batch=${selectedSlug}`} target="_blank" rel="noopener noreferrer" className="text-xs font-bold text-blue-600 shrink-0 ml-2">Open full page ↗</a></div><iframe key={selectedSlug} src={`${appUrl}/register?batch=${selectedSlug}`} className="w-full" style={{ height: 640, border: "none" }} title="Registration form preview" /></div>}
            </>}
        </section>
        )}

        {activeTab === "dashboard" && (
        <section>
          <select value={dashCollege} onChange={e => setDashCollege(e.target.value)} className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm mb-3">{pickerColleges.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {dashCollegeBatches.length === 0 ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">No {dashCollege} batches yet.</div> : <select value={dashSlug} onChange={e => setDashSlug(e.target.value)} className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm mb-3">{dashCollegeBatches.map(b => <option key={b.id} value={b.slug}>{b.name}</option>)}</select>}
          {!dashSelectedBatch ? null : dashStudentsLoading ? <div className="rounded-2xl border border-gray-100 bg-white p-6 text-center text-sm text-gray-400">Loading students…</div> : dashStudents.length === 0 ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">No registered students in {dashSelectedBatch.name} yet.</div> : <>
            <div className="flex flex-col sm:flex-row gap-2 mb-3">
              <select value={selectedStudentId} onChange={e => { setSelectedStudentId(e.target.value); setPreviewToken(""); setPreviewError(""); }} className="flex-1 min-w-0 bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm"><option value="">Select a student…</option>{dashStudents.map(s => <option key={s.id} value={s.id}>{s.full_name}{s.roll_number ? ` — ${s.roll_number}` : ""}</option>)}</select>
              <button onClick={openDashboardPreview} disabled={!selectedStudentId || previewLoading} className="text-sm font-bold rounded-xl px-4 py-2 bg-blue-600 text-white disabled:opacity-50 whitespace-nowrap shrink-0">{previewLoading ? "Opening…" : "Open student app"}</button>
            </div>
            {previewError && <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 mb-3">{previewError}</div>}
            {previewToken && <div className="rounded-2xl border border-gray-200 overflow-hidden bg-white shadow-sm"><div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100"><span className="text-xs text-amber-700 font-semibold">Live student session · expires in 10 minutes</span><span className="text-[11px] text-gray-400">Actions affect the selected student's account</span></div><iframe key={previewToken} src={`${appUrl}/dashboard?preview_token=${previewToken}`} className="w-full" style={{ height: 720, border: "none" }} title="Interactive student dashboard" /></div>}
          </>
          }
        </section>
        )}

        {activeTab === "routemap" && <section><select value={routeCollege} onChange={e => setRouteCollege(e.target.value)} className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm mb-4">{pickerColleges.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"><RouteMap college={routeCollege} /></div></section>}
      </div>
      )}
    </div>
  );
}
