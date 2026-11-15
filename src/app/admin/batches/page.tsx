"use client";
import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Users, Bell, Pencil, Link2, Archive, Trash2, FlagTriangleRight, ClipboardList,
  X, Infinity as InfinityIcon, MessageCircle, Scale, UserCog,
} from "lucide-react";

interface CollegeOpt { id: string; name: string; }

function AdminBatchesInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [batches, setBatches]         = useState<any[]>([]);
  const [showForm, setShowForm]       = useState(false);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [deleting, setDeleting]       = useState(false);
  const [endTarget, setEndTarget]     = useState<any | null>(null);
  const [ending, setEnding]           = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState({
    college: "", batchNumber: "", fee_amount: 2000,
    limitType: "unlimited" as "unlimited" | "limited",
    batch_limit: 70,
    alertEnabled: false,
    low_seat_alert_threshold: 5,
  });
  // Court case details are a standalone action on the batch card (see
  // caseTarget/caseForm below) — not buried inside this general Edit sheet.
  // Live-reported as hard to find there: "Not the edit but a new option to
  // enter the court case number."
  const [caseTarget, setCaseTarget] = useState<any | null>(null);
  const [caseForm, setCaseForm] = useState({ case_type: "", case_number: "", case_year: "", case_status_url: "" });
  const [savingCase, setSavingCase] = useState(false);
  const [showCaseAdvanced, setShowCaseAdvanced] = useState(false);
  // Batch Representative — the student who takes initiative once the
  // Court Order hard-copy parcel (item #172) arrives: arranges Xerox
  // reference copies for the batch. Same standalone-modal pattern as Court
  // Case Number above, not buried in the general Edit sheet either.
  const [repTarget, setRepTarget] = useState<any | null>(null);
  const [repForm, setRepForm] = useState({ representative_name: "", representative_phone: "" });
  const [savingRep, setSavingRep] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [colleges, setColleges] = useState<CollegeOpt[]>([{ id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" }]);

  const h = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });
  function showToast(msg: string, ok: boolean = true) { setToast({ msg, ok }); setTimeout(() => setToast(null), 4000); }

  useEffect(() => { loadBatches(); }, []);
  useEffect(() => {
    fetch("/api/settings/colleges").then(r => r.json()).then(j => {
      if (j.data?.length) {
        setColleges(j.data);
        setForm(f => f.college ? f : { ...f, college: j.data[0].id });
      }
    }).catch(() => {});
  }, []);

  function loadBatches() {
    setLoading(true);
    // no-store — student_count changes as registrations complete; see
    // batches-overview/page.tsx's same fix for why this matters here too.
    fetch("/api/admin/batches", { headers: h(), cache: "no-store" })
      .then(r => r.json())
      .then(j => { setBatches(j.data ?? []); setLoading(false); });
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  // Split active/paused vs archived
  const activeBatches   = batches.filter(b => b.status !== "archived");
  const archivedBatches = batches.filter(b => b.status === "archived");

  // Match "Batch 7", not any trailing digits — archived rows are named
  // "GNIT archived draft 2026-07-08", whose trailing "08" would otherwise read
  // as batch 8 and silently block that number.
  const batchNumberOf = (name?: string | null): number | null => {
    const m = /\bBatch\s+(\d+)\b/i.exec(name ?? "");
    return m ? parseInt(m[1]) : null;
  };

  function takenNumbers(college: string): number[] {
    return activeBatches
      .filter(b => b.college === college)
      .map(b => batchNumberOf(b.name))
      .filter((n): n is number => n !== null);
  }

  /** Next number in the sequence — same rule as nextBatchName() on the server,
   *  so creating a batch here and ending one from WhatsApp agree. */
  function nextNumber(college: string): number {
    const used = takenNumbers(college);
    return used.length ? Math.max(...used) + 1 : 1;
  }

  function openCreate(presetCollege?: string) {
    const valid = colleges.some(c => c.id === presetCollege);
    setEditingId(null);
    // When opened from the batches-overview "+ New Batch" button, the
    // college is already decided by which college screen you were on —
    // showing an editable dropdown here would let you silently create a
    // GNIT batch while inside the GNITC screen, which is exactly the
    // confusing behavior being fixed. Lock it instead of just pre-filling it.
    setLockedCollege(valid ? presetCollege! : null);
    setForm({
      college: valid ? presetCollege! : (colleges[0]?.id ?? "GNIT"),
      batchNumber: "", fee_amount: 2000, limitType: "unlimited", batch_limit: 70,
      alertEnabled: false, low_seat_alert_threshold: 5,
    });
    setShowForm(true);
  }

  // Voice command support: /admin/batches?new=1 auto-opens the create form,
  // so "create a batch" can actually do something useful in one step
  // instead of just landing on a list the admin still has to act on.
  // ?college= also lets the "+ New Batch" button on the batches-overview
  // screen (reached by tapping GNIT/GNITC) pre-select the right college
  // instead of always defaulting to GNIT.
  useEffect(() => {
    if (searchParams.get("new") === "1") openCreate(searchParams.get("college") ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ?edit=<batchId> — lets the "Edit batch" action in the batches-overview
  // action sheet jump straight into the edit form for that specific batch,
  // instead of only being reachable from this page's own (unfiltered) list.
  useEffect(() => {
    const editId = searchParams.get("edit");
    if (!editId || batches.length === 0) return;
    const target = batches.find(b => b.id === editId);
    if (target) openEdit(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, batches]);

  const [lockedCollege, setLockedCollege] = useState<string | null>(null);

  // Default the batch number to the next one in the sequence. Only fills a
  // blank or now-invalid choice, so an admin who deliberately picks another
  // number keeps it.
  useEffect(() => {
    if (!showForm || editingId || !form.college || batches.length === 0) return;
    const used = takenNumbers(form.college);
    const current = Number(form.batchNumber);
    if (form.batchNumber && !used.includes(current)) return;
    setForm(f => ({ ...f, batchNumber: String(nextNumber(f.college)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm, editingId, form.college, batches]);

  function openEdit(b: any) {
    setLockedCollege(null); // editing an existing batch never locks the college field
    setEditingId(b.id);
    const n = batchNumberOf(b.name);
    setForm({
      college: b.college ?? (colleges[0]?.id ?? "GNIT"),
      batchNumber: n != null ? String(n) : "",
      fee_amount: Number(b.fee_amount) ?? 0,
      limitType: b.batch_limit != null ? "limited" : "unlimited",
      batch_limit: b.batch_limit ?? 70,
      alertEnabled: b.low_seat_alert_threshold != null,
      low_seat_alert_threshold: b.low_seat_alert_threshold ?? 5,
    });
    setShowForm(true);
  }

  // Everything except the number itself is the same for every batch's
  // petition — one court (TSHC), one case type (Writ Petition), filed this
  // year. Defaulting these fields keeps the admin form concise. Only defaults
  // when the batch has nothing on file yet — never overwrites a value already saved,
  // and an admin can still edit any of the three under "Advanced".
  const DEFAULT_CASE_TYPE = "WP";
  const DEFAULT_CASE_STATUS_URL = "https://csis.tshc.gov.in/";

  function openCaseModal(b: any) {
    setCaseTarget(b);
    setCaseForm({
      case_type: b.case_type ?? DEFAULT_CASE_TYPE,
      case_number: b.case_number ?? "",
      case_year: b.case_year ?? String(new Date().getFullYear()),
      case_status_url: b.case_status_url ?? DEFAULT_CASE_STATUS_URL,
    });
    setShowCaseAdvanced(false);
  }

  async function saveCaseDetails() {
    if (!caseTarget) return;
    if (!caseForm.case_number.trim()) { showToast("Enter the case number", false); return; }
    setSavingCase(true);
    // Empty string means "clear it" — the PATCH route maps that to null.
    const payload = {
      case_type: caseForm.case_type.trim(),
      case_number: caseForm.case_number.trim(),
      case_year: caseForm.case_year.trim(),
      case_status_url: caseForm.case_status_url.trim(),
    };
    const res = await fetch(`/api/admin/batches/${caseTarget.id}`, { method: "PATCH", headers: h(), body: JSON.stringify(payload) });
    const j = await res.json();
    setSavingCase(false);
    if (j.success) {
      setCaseTarget(null);
      loadBatches();
      showToast("Case details saved");
    } else {
      showToast(j.error ?? "Save failed", false);
    }
  }

  function openRepModal(b: any) {
    setRepTarget(b);
    setRepForm({
      representative_name: b.representative_name ?? "",
      representative_phone: b.representative_phone ?? "",
    });
  }

  async function saveRepDetails() {
    if (!repTarget) return;
    if (!repForm.representative_name.trim()) { showToast("Enter the representative's name", false); return; }
    setSavingRep(true);
    // Empty string means "clear it" — the PATCH route maps that to null.
    const payload = {
      representative_name: repForm.representative_name.trim(),
      representative_phone: repForm.representative_phone.trim(),
    };
    const res = await fetch(`/api/admin/batches/${repTarget.id}`, { method: "PATCH", headers: h(), body: JSON.stringify(payload) });
    const j = await res.json();
    setSavingRep(false);
    if (j.success) {
      setRepTarget(null);
      loadBatches();
      showToast("Batch representative saved");
    } else {
      showToast(j.error ?? "Save failed", false);
    }
  }

  async function save() {
    if (!editingId && !form.batchNumber) { showToast("Please select a batch number", false); return; }
    setSaving(true);
    const name = editingId
      ? batches.find(b => b.id === editingId)?.name
      : `${form.college} Batch ${form.batchNumber}`;
    const payload: any = {
      name, college: form.college,
      fee_amount: Number(form.fee_amount),
      batch_limit: form.limitType === "limited" ? Number(form.batch_limit) : null,
      low_seat_alert_threshold: (form.limitType === "limited" && form.alertEnabled)
        ? Number(form.low_seat_alert_threshold) : null,
    };
    const url    = editingId ? `/api/admin/batches/${editingId}` : "/api/batches";
    const method = editingId ? "PATCH" : "POST";
    const res = await fetch(url, { method, headers: h(), body: JSON.stringify(payload) });
    const j   = await res.json();
    setSaving(false);
    if (j.success) {
      setShowForm(false);
      showToast(editingId ? "Batch updated" : "Batch created");
      if (!editingId && lockedCollege) {
        router.push(`/admin/batches-overview?college=${lockedCollege}`);
      } else {
        loadBatches();
      }
    }
    else showToast(j.error ?? "Save failed", false);
  }

  async function toggleStatus(b: any) {
    const newStatus = b.status === "active" ? "paused" : "active";
    const res = await fetch(`/api/admin/batches/${b.id}`, { method: "PATCH", headers: h(), body: JSON.stringify({ status: newStatus }) });
    const j   = await res.json();
    if (j.success) { loadBatches(); showToast(`Batch ${newStatus}`); }
    else showToast(j.error ?? "Update failed", false);
  }

  async function archiveBatch(b: any) {
    const res = await fetch(`/api/admin/batches/${b.id}`, { method: "PATCH", headers: h(), body: JSON.stringify({ status: "archived" }) });
    const j   = await res.json();
    if (j.success) { loadBatches(); showToast("Batch archived"); }
    else showToast(j.error ?? "Archive failed", false);
  }

  async function shareBatch(b: any) {
    // Fallback is the bot @username ALPHAGIT_BOT — verified via getMe 2026-07-02
    // (see api/admin/invites); "Students_bot" is only the bot's display name and
    const appUrl = window.location.origin;
    const link = `${appUrl}/register?batch=${encodeURIComponent(b.slug)}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast("Link copied!");
    } catch {
      showToast(link);
    }
  }

  async function confirmEndBatch() {
    if (!endTarget) return;
    setEnding(true);
    const res = await fetch(`/api/admin/batches/${endTarget.id}/end`, { method: "POST", headers: h() });
    const j   = await res.json();
    setEnding(false); setEndTarget(null);
    if (j.success) {
      loadBatches();
      showToast(`${j.data?.new_batch?.name ?? "Next batch"} created — set its fee`);
    } else {
      showToast(j.error ?? "Could not end batch", false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await fetch(`/api/admin/batches/${deleteTarget.id}`, { method: "DELETE", headers: h() });
    const j   = await res.json();
    setDeleting(false); setDeleteTarget(null);
    if (j.success) { loadBatches(); showToast("Batch deleted"); }
    else showToast(j.error ?? "Delete failed", false);
  }

  const inp   = "w-full border border-gray-200 bg-gray-50 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300";
  const taken = takenNumbers(form.college);

  function BatchCard({ b }: { b: any }) {
    const isArchived = b.status === "archived";
    return (
      <div className={`bg-white rounded-2xl p-4 shadow-sm ${isArchived ? "opacity-60" : ""}`}>
        <div className="flex justify-between items-start">
          <div>
            <p className="font-semibold">{b.name}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              {b.college} · {b.fee_amount == null
                ? <span className="text-orange-600 font-semibold">Fee not set</span>
                : `₹${Number(b.fee_amount).toLocaleString("en-IN")}`} · {b.slug}
            </p>
            <div className="flex items-center gap-2 mt-1">
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600">
                <Users size={11} strokeWidth={2} /> {b.student_count ?? 0} students
              </span>
              {b.batch_limit != null && (
                <span className="text-xs text-amber-600">
                  / {b.batch_limit} limit
                </span>
              )}
              {b.low_seat_alert_threshold != null && (
                <span className="text-blue-500" title={`Alerts at ${b.low_seat_alert_threshold} seats left`}>
                  <Bell size={11} strokeWidth={2} />
                </span>
              )}
              {b.case_number && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-purple-600" title="Court case on file">
                  <Scale size={11} strokeWidth={2} /> {[b.case_type, b.case_number].filter(Boolean).join(" ")}
                </span>
              )}
              {b.representative_name && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal-600" title="Batch representative">
                  <UserCog size={11} strokeWidth={2} /> {b.representative_name}
                </span>
              )}
            </div>
          </div>
          <span className={`text-xs px-2 py-1 rounded-full font-medium ${
            b.status === "active"   ? "bg-green-100 text-green-700" :
            b.status === "paused"   ? "bg-amber-100 text-amber-700" :
                                      "bg-gray-100 text-gray-500"
          }`}>{b.status}</span>
        </div>

        <div className="flex items-center gap-3 mt-2 text-[11px] text-gray-400">
          <span>Created {new Date(b.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
          {b.updated_at && b.updated_at !== b.created_at && (
            <span>· Updated {new Date(b.updated_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
          )}
        </div>

        {!isArchived && (
          <>
            <div className="flex gap-2 mt-3">
              <button onClick={() => openEdit(b)}   className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-blue-50 text-blue-600 py-2 rounded-xl font-medium"><Pencil size={13} strokeWidth={2} /> Edit</button>
              <button onClick={() => toggleStatus(b)} className="flex-1 text-sm bg-gray-100 text-gray-600 py-2 rounded-xl font-medium">
                {b.status === "active" ? "Pause" : "Resume"}
              </button>
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => shareBatch(b)}    className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-indigo-50 text-indigo-600 py-2 rounded-xl font-medium"><Link2 size={13} strokeWidth={2} /> Share</button>
              <button onClick={() => archiveBatch(b)}  className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-gray-100 text-gray-500 py-2 rounded-xl font-medium"><Archive size={13} strokeWidth={2} /> Archive</button>
              <button onClick={() => setDeleteTarget(b)} className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-red-50 text-red-600 py-2 rounded-xl font-medium"><Trash2 size={13} strokeWidth={2} /> Delete</button>
            </div>
            <button onClick={() => router.push(`/admin/group-chat/${b.id}`)}
              className="w-full flex items-center justify-center gap-1.5 text-sm bg-blue-50 text-blue-700 py-2 rounded-xl font-medium mt-2">
              <MessageCircle size={13} strokeWidth={2} /> Discussion
            </button>
            <button onClick={() => openCaseModal(b)}
              className="w-full flex items-center justify-center gap-1.5 text-sm bg-purple-50 text-purple-700 py-2 rounded-xl font-medium mt-2">
              <Scale size={13} strokeWidth={2} /> {b.case_number ? "Edit Case Number" : "Add Case Number"}
            </button>
            <button onClick={() => openRepModal(b)}
              className="w-full flex items-center justify-center gap-1.5 text-sm bg-teal-50 text-teal-700 py-2 rounded-xl font-medium mt-2">
              <UserCog size={13} strokeWidth={2} /> {b.representative_name ? "Edit Batch Representative" : "Add Batch Representative"}
            </button>
            {/* End Batch — the only way to start the next batch. Active batch only. */}
            {b.status === "active" && (
              <button onClick={() => setEndTarget(b)}
                className="w-full flex items-center justify-center gap-1.5 text-sm bg-orange-50 text-orange-700 border border-orange-200 py-2.5 rounded-xl font-semibold mt-2">
                <FlagTriangleRight size={14} strokeWidth={2} /> End Batch & Start Next
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      <div className="bg-blue-600 text-white px-4 pt-10 pb-5">
        <button onClick={() => router.back()} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.15)", border:"1.5px solid rgba(255,255,255,0.25)", borderRadius:14, padding:"8px 16px 8px 10px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", marginBottom:18, backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div className="flex justify-between items-center">
          <h1 className="text-xl font-bold">Batches</h1>
          <button onClick={() => openCreate()} className="bg-white/20 px-3 py-1.5 rounded-full text-sm font-medium">+ New</button>
        </div>
      </div>

      {toast && (
        <div className={`mx-4 mt-3 text-sm p-3 rounded-xl text-center ${toast.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
          {toast.msg}
        </div>
      )}

      <div className="px-4 mt-4 space-y-3">
        {loading ? (
          <p className="text-center text-gray-400 py-8 text-sm">Loading…</p>
        ) : activeBatches.length === 0 ? (
          <div className="text-center py-12">
            <ClipboardList size={30} strokeWidth={1.6} className="mx-auto mb-3 text-gray-300" />
            <p className="text-gray-500 font-semibold">No batches yet</p>
            <p className="text-gray-400 text-sm mt-1">Tap + New to create one</p>
          </div>
        ) : (
          activeBatches.map(b => <BatchCard key={b.id} b={b} />)
        )}

        {/* Archived section — collapsed by default */}
        {archivedBatches.length > 0 && (
          <div className="pt-2">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full flex items-center justify-between px-4 py-3 bg-white rounded-2xl shadow-sm text-sm text-gray-500 font-medium"
            >
              <span className="inline-flex items-center gap-1.5"><Archive size={13} strokeWidth={2} /> Archived Batches ({archivedBatches.length})</span>
              <span>{showArchived ? "▲" : "▼"}</span>
            </button>
            {showArchived && (
              <div className="mt-2 space-y-3">
                {archivedBatches.map(b => <BatchCard key={b.id} b={b} />)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
          <div className="bg-white w-full rounded-t-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center">
              <h2 className="font-bold text-lg">{editingId ? "Edit Batch" : "New Batch"}</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-400"><X size={18} strokeWidth={2} /></button>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">College</label>
              {lockedCollege ? (
                <div className={`${inp} bg-gray-50 text-gray-700 font-semibold flex items-center justify-between`}>
                  <span>{lockedCollege}</span>
                  <span className="text-[10px] text-gray-400 font-normal">Locked — creating from {lockedCollege} screen</span>
                </div>
              ) : (
                <select className={inp} value={form.college} onChange={set("college")}>
                  {colleges.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  {/* The batch's own college may be inactive (e.g. BIET), so it
                      is not in the list above — without this the select shows
                      the first option instead of the batch's real college. */}
                  {form.college && !colleges.some(c => c.id === form.college) && (
                    <option key={form.college} value={form.college}>{form.college}</option>
                  )}
                </select>
              )}
            </div>

            {!editingId && (
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Batch Number</label>
                <select className={inp} value={form.batchNumber} onChange={set("batchNumber")}>
                  <option value="">Select batch number…</option>
                  {Array.from({ length: 20 }, (_, i) => i + 1).map(n => (
                    <option key={n} value={String(n)} disabled={taken.includes(n)}>
                      {n}{taken.includes(n) ? " (already used)" : ""}{!taken.includes(n) && n === nextNumber(form.college) ? " — next" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Fee Amount (₹)</label>
              <input type="number" className={inp} placeholder="2000" value={form.fee_amount} onChange={set("fee_amount")} />
            </div>



            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Batch Capacity</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setForm(f => ({ ...f, limitType: "unlimited" }))}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium border transition-colors ${
                    form.limitType === "unlimited" ? "bg-blue-600 text-white border-blue-600" : "bg-gray-50 text-gray-600 border-gray-200"
                  }`}>
                  <InfinityIcon size={14} strokeWidth={2} /> Unlimited
                </button>
                <button type="button" onClick={() => setForm(f => ({ ...f, limitType: "limited" }))}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium border transition-colors ${
                    form.limitType === "limited" ? "bg-blue-600 text-white border-blue-600" : "bg-gray-50 text-gray-600 border-gray-200"
                  }`}>
                  <Users size={14} strokeWidth={2} /> Set Limit
                </button>
              </div>
              {form.limitType === "limited" && (
                <div className="mt-2 space-y-2">
                  <input type="number" min={1} className={inp} placeholder="e.g. 70"
                    value={form.batch_limit} onChange={set("batch_limit")} />

                  {/* Low-seat Telegram alert */}
                  <label className="flex items-center gap-2 px-1 py-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.alertEnabled}
                      onChange={e => setForm(f => ({ ...f, alertEnabled: e.target.checked }))}
                      className="w-4 h-4 rounded accent-blue-600"
                    />
                    <span className="text-xs font-medium text-gray-600 inline-flex items-center gap-1.5">
                      <Bell size={12} strokeWidth={2} /> Alert me on WhatsApp when seats run low
                    </span>
                  </label>

                  {form.alertEnabled && (
                    <div className="flex items-center gap-2 pl-1">
                      <span className="text-xs text-gray-400 whitespace-nowrap">Notify when</span>
                      <input
                        type="number" min={0} max={form.batch_limit}
                        className="w-16 border border-gray-200 bg-gray-50 rounded-lg px-2 py-1.5 text-sm text-center"
                        value={form.low_seat_alert_threshold}
                        onChange={e => setForm(f => ({ ...f, low_seat_alert_threshold: Number(e.target.value) }))}
                      />
                      <span className="text-xs text-gray-400 whitespace-nowrap">seats left</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={() => {
                setShowForm(false);
                if (lockedCollege) router.push(`/admin/batches-overview?college=${lockedCollege}`);
              }} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-semibold">Cancel</button>
              <button onClick={save} disabled={saving} className="flex-1 bg-blue-600 text-white py-3 rounded-xl font-semibold disabled:opacity-60">
                {saving ? "Saving…" : editingId ? "Update" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Court Case Number — a standalone action from each batch card, not
          buried inside the general Edit sheet (live report: "Not the edit
          but a new option to enter the court case number"). */}
      {caseTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-3">
            <div className="flex items-center gap-2">
              <Scale size={20} strokeWidth={2} className="text-purple-600" />
              <h2 className="font-bold text-lg">Court Case Number</h2>
            </div>
            <p className="text-xs text-gray-500">
              Once the lawyer files <strong>{caseTarget.name}</strong>&apos;s petition,
              just enter the case number — everything else (court, case type,
              year) is filled in for you. Leave it blank until then.
            </p>
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1">Case Number *</label>
              <input className={`${inp} text-base font-semibold`} placeholder="e.g. WP number/year" autoFocus
                value={caseForm.case_number} onChange={e => setCaseForm(f => ({ ...f, case_number: e.target.value }))} />
            </div>
            <button type="button" onClick={() => setShowCaseAdvanced(v => !v)}
              className="text-xs font-semibold text-gray-500 underline">
              {showCaseAdvanced ? "Hide" : "Edit"} case type, year & link (auto-filled)
            </button>
            {showCaseAdvanced && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input className={inp} placeholder="Case type (e.g. WP)"
                    value={caseForm.case_type} onChange={e => setCaseForm(f => ({ ...f, case_type: e.target.value }))} />
                  <input className={inp} placeholder="Year (e.g. 2026)"
                    value={caseForm.case_year} onChange={e => setCaseForm(f => ({ ...f, case_year: e.target.value }))} />
                </div>
                <input className={inp} placeholder="Status-check link (e.g. https://csis.tshc.gov.in/)"
                  value={caseForm.case_status_url} onChange={e => setCaseForm(f => ({ ...f, case_status_url: e.target.value }))} />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setCaseTarget(null)} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-semibold">Cancel</button>
              <button onClick={saveCaseDetails} disabled={savingCase}
                className="flex-1 bg-purple-600 text-white py-3 rounded-xl font-semibold disabled:opacity-60">
                {savingCase ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Representative — the student who arranges reference Xerox
          copies once the Court Order parcel (item #172) arrives, per batch. */}
      {repTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-3">
            <div className="flex items-center gap-2">
              <UserCog size={20} strokeWidth={2} className="text-teal-600" />
              <h2 className="font-bold text-lg">Batch Representative</h2>
            </div>
            <p className="text-xs text-gray-500">
              The student who takes initiative for <strong>{repTarget.name}</strong> once
              the Court Order parcel arrives — arranges Xerox reference copies for the batch.
            </p>
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1">Name *</label>
              <input className={`${inp} text-base font-semibold`} placeholder="e.g. Sample Name" autoFocus
                value={repForm.representative_name} onChange={e => setRepForm(f => ({ ...f, representative_name: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1">Phone (optional)</label>
              <input className={inp} placeholder="10-digit mobile number"
                value={repForm.representative_phone} onChange={e => setRepForm(f => ({ ...f, representative_phone: e.target.value }))} />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setRepTarget(null)} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-semibold">Cancel</button>
              <button onClick={saveRepDetails} disabled={savingRep}
                className="flex-1 bg-teal-600 text-white py-3 rounded-xl font-semibold disabled:opacity-60">
                {savingRep ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {endTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-4">
            <FlagTriangleRight size={26} strokeWidth={2} className="mx-auto text-orange-600" />
            <h2 className="font-bold text-lg text-center">End this batch?</h2>
            <p className="text-sm text-gray-500 text-center">
              <strong>{endTarget.name}</strong> will be <strong>Closed</strong>, and the next batch
              for {endTarget.college} will be created as the new <strong>Active</strong> batch.
            </p>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3 text-center">
              The new batch will have <strong>no fee set</strong> — payments stay blocked until you
              set it. You'll get a reminder to configure the fee.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setEndTarget(null)} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-semibold">Cancel</button>
              <button onClick={confirmEndBatch} disabled={ending}
                className="flex-1 bg-orange-600 text-white py-3 rounded-xl font-semibold disabled:opacity-60">
                {ending ? "Ending…" : "End Batch"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm space-y-4">
            <Trash2 size={26} strokeWidth={2} className="mx-auto text-red-600" />
            <h2 className="font-bold text-lg text-center">Delete Batch?</h2>
            <p className="text-sm text-gray-500 text-center">
              <strong>{deleteTarget.name}</strong> will be permanently deleted.<br />
              This will fail if students are enrolled.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-semibold">Cancel</button>
              <button onClick={confirmDelete} disabled={deleting}
                className="flex-1 bg-red-600 text-white py-3 rounded-xl font-semibold disabled:opacity-60">
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminBatches() {
  return (
    <Suspense fallback={null}>
      <AdminBatchesInner />
    </Suspense>
  );
}
