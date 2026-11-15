"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Check, Clock, Paperclip, X, AlertTriangle, Phone, Users2, ClipboardList,
  Receipt, CalendarDays, Home, Pencil, FileText, Trash2, Lock,
  CreditCard, Eye, RefreshCw, Upload, Search, UserPlus, ShieldCheck,
} from "lucide-react";
import AddSpotStudentSheet from "@/components/admin/AddSpotStudentSheet";

type Student = {
  id: string; full_name: string; father_name: string | null;
  college_id_path: string | null; college_id_ai_flag: { isIdCard: boolean; hasSignature: boolean; notes: string | null } | null;
  photo_signature_path: string | null; username: string; home_address: string | null;
  phone: string; college: string; roll_number: string; branch: string;
  year: number; role: string; is_profile_complete: boolean; batch_id: string | null; created_at: string;
  batches?: { name: string; slug: string; fee_amount: number; college: string } | null;
  payment_order?: number; batch_approved_total?: number;
  pay_status?: string; utr_number?: string | null; payment_id?: string | null;
};

// Payment status badge shown per student on the roster, so an admin doing
// manual verification can see at a glance who has paid / is awaiting review.
const PAY_BADGE: Record<string, { label: string; cls: string }> = {
  approved:           { label: "Paid",          cls: "bg-green-100 text-green-700" },
  submitted:          { label: "Under review",  cls: "bg-amber-100 text-amber-700" },
  reupload_requested: { label: "Re-upload",     cls: "bg-orange-100 text-orange-700" },
  rejected:           { label: "Rejected",      cls: "bg-red-100 text-red-700" },
  pg_failed:          { label: "Failed",        cls: "bg-red-100 text-red-700" },
  none:               { label: "Not paid",      cls: "bg-gray-100 text-gray-500" },
};

function AdminStudentsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [students, setStudents] = useState<Student[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  // Deep-link support: tapping GNIT/GNITC on the dashboard navigates here
  // with ?college=GNIT — read that as the initial filter value instead of
  // silently ignoring it. No "All" view: the roster is college-first — a
  // college is always selected and the page shows only that college, never
  // a grand total across colleges (admin request, 11 Nov 2026). Default to
  // the first college when no deep link is given.
  const [college, setCollege] = useState(() => searchParams.get("college") || "GNIT");
  // Fetched, not hardcoded — a fixed All/GNIT/GNITC list here silently made
  // filtering to (or editing a student onto) any later college impossible.
  // Same trap as items #101/#107/#114/#118, this time on the roster itself.
  const [colleges, setColleges] = useState<{ id: string; name: string }[]>([
    { id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" },
  ]);
  const [payStatus, setPayStatus] = useState(() => searchParams.get("pay_status") ?? "");
  const [batchId, setBatchId] = useState(() => searchParams.get("batch_id") ?? "");
  const [batchSummary, setBatchSummary] = useState<{ registered: number; paid: number; awaiting_review: number; not_paid: number; min_seats: number; seats_remaining: number } | null>(null);
  const [batches, setBatches] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState<Student | null>(null);
  const [editData, setEditData] = useState<Partial<Student>>({});
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [adminTarget, setAdminTarget] = useState<Student | null>(null);
  const [adminCounts, setAdminCounts] = useState<Record<string, number>>({});
  const [adminSaving, setAdminSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [incompleteOpen, setIncompleteOpen] = useState(false);
  const [docsStudent, setDocsStudent] = useState<Student | null>(null);
  const [viewingField, setViewingField] = useState<string | null>(null);
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [checkingSignature, setCheckingSignature] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Adding a spot student is now super_admin-only, per direct request —
  // hidden here too (not just enforced server-side, POST /api/admin/students)
  // so a plain admin doesn't see a button that would just 403. Same
  // localStorage.sp_role convention admin/page.tsx already uses.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  useEffect(() => { setIsSuperAdmin(localStorage.getItem("sp_role") === "super_admin"); }, []);
  const fileInputRef = useState<HTMLInputElement | null>(null);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  useEffect(() => { load(); }, [q, college, batchId, payStatus]);

  useEffect(() => {
    fetch("/api/settings/colleges").then(r => r.json()).then(j => {
      if (Array.isArray(j.data) && j.data.length) {
        setColleges(j.data);
        // If the current selection (deep link or default) is not a real
        // college anymore, fall back to the first one so the page never
        // sits on an unselectable filter showing zero students.
        setCollege(prev => j.data.some((c: { id: string }) => c.id === prev) ? prev : j.data[0].id);
      }
    }).catch(() => {});
  }, []);

  // Batch-level payment counter — fetched independently of the roster filters
  // so it always shows the whole batch's payment breakdown. Refreshes whenever
  // the selected batch changes (and re-runs after actions via the same key).
  useEffect(() => {
    if (!batchId) { setBatchSummary(null); return; }
    let cancelled = false;
    fetch(`/api/admin/batch-summary?batch_id=${batchId}`, { headers: h() })
      .then(r => r.json())
      .then(j => { if (!cancelled) setBatchSummary(j.success ? j.data : null); })
      .catch(() => { if (!cancelled) setBatchSummary(null); });
    return () => { cancelled = true; };
  }, [batchId, payStatus, q]);

  // Whenever the ADMIN changes the college filter, reset the previously
  // selected batch (it may not belong to the new college) and fetch that
  // college's batches for the second-level dropdown. This effect also runs
  // once on mount (college is a dependency), which was unconditionally
  // clearing a batch_id that arrived via a dashboard deep link — e.g.
  // tapping "Paid" on a batch card — before the first fetch ever used it.
  // Skip the reset on that initial run only.
  const didMountCollegeFilter = useRef(false);
  useEffect(() => {
    if (didMountCollegeFilter.current) setBatchId("");
    didMountCollegeFilter.current = true;
    if (!college) { setBatches([]); return; }
    fetch(`/api/admin/batches?college=${college}`, { headers: h() })
      .then(r => r.json())
      .then(j => setBatches(Array.isArray(j.data) ? j.data : []))
      .catch(() => setBatches([]));
  }, [college]);

  function showToast(msg: string, ok: boolean = true) { setToast({ msg, ok }); setTimeout(() => setToast(null), 4000); }

function load() {
  setLoading(true);
  setPage(1);
  // Never hang forever: if the roster API stalls (it did for 2+ min on
  // 2026-11-10), abort after 20s and let the user retry instead of
  // spinning on "Loading..." indefinitely.
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  fetch(`/api/admin/students?q=${encodeURIComponent(q)}&college=${college}&batch_id=${batchId}&pay_status=${payStatus}&page=1`, { headers: h(), signal: controller.signal })
    .then(async r => {
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.success) {
        showToast(`Load failed: ${r.status} ${j?.error ?? ""}`, false);
        setStudents([]); setTotal(0);
      } else {
        setStudents(j.data?.students ?? []);
        setTotal(j.data?.total ?? 0);
        if (j.data?.admin_counts) setAdminCounts(j.data.admin_counts);
      }
      setLoading(false);
    })
    .catch((e) => { window.clearTimeout(timeout); showToast(e?.name === "AbortError" ? "Load timed out — tap a filter to retry" : "Network error loading students", false); setLoading(false); })
    .finally(() => window.clearTimeout(timeout));
}

  function loadMore() {
    const nextPage = page + 1;
    setLoadingMore(true);
    fetch(`/api/admin/students?q=${encodeURIComponent(q)}&college=${college}&batch_id=${batchId}&pay_status=${payStatus}&page=${nextPage}`, { headers: h() })
      .then(r => r.json())
      .then(j => {
        setStudents(prev => [...prev, ...(j.data?.students ?? [])]);
        if (j.data?.admin_counts) setAdminCounts(j.data.admin_counts);
        setPage(nextPage);
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }

  function openEdit(s: Student) { setEditing(s); setEditData({ ...s }); }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    const res = await fetch(`/api/admin/students/${editing.id}`, {
      method: "PATCH",
      headers: { ...h(), "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: editData.full_name, phone: editData.phone,
        college: editData.college, branch: editData.branch,
        year: editData.year ? Number(editData.year) : undefined,
        roll_number: editData.roll_number,
        home_address: editData.home_address,
      }),
    });
    const j = await res.json();
    setSaving(false);
    if (j.success) {
      setStudents(prev => prev.map(s => s.id === editing.id ? { ...s, ...editData } : s));
      setEditing(null);
      showToast("Student updated");
    } else {
      showToast(j.error ?? "Save failed", false);
    }
  }

  async function confirmDelete() {
    if (!deleteId) return;
    if (!deleteReason.trim()) { showToast("Please enter a reason", false); return; }
    setDeleting(true);
    const res = await fetch(`/api/admin/students/${deleteId}`, {
      method: "DELETE",
      cache: "no-store",
      headers: { ...h(), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: deleteReason.trim() }),
    });
    const j = await res.json();
    setDeleting(false);
    setDeleteId(null);
    setDeleteReason("");
    if (j.success) {
      setStudents(prev => prev.filter(s => s.id !== deleteId));
      setTotal(prev => prev - 1);
      showToast("Student deleted");
    } else {
      showToast(j.error ?? "Delete failed", false);
    }
  }

  // "Make as Admin" / "Remove admin" — super_admin only (button is hidden
  // for everyone else, and the API re-checks + enforces max 2 admins per
  // batch server-side). Action is derived from the student's current role.
  async function confirmAdminChange() {
    if (!adminTarget) return;
    const action = adminTarget.role === "admin" ? "remove" : "make";
    setAdminSaving(true);
    try {
      const res = await fetch(`/api/admin/users/make-admin`, {
        method: "POST",
        headers: { ...h(), "Content-Type": "application/json" },
        body: JSON.stringify({ student_id: adminTarget.id, action }),
      });
      const j = await res.json();
      if (j.success) {
        setStudents(prev => prev.map(s => s.id === adminTarget.id ? { ...s, role: action === "make" ? "admin" : "student" } : s));
        if (adminTarget.batch_id) {
          const bid = adminTarget.batch_id;
          setAdminCounts(prev => ({ ...prev, [bid]: Math.max(0, (prev[bid] ?? 0) + (action === "make" ? 1 : -1)) }));
        }
        showToast(j.data?.message ?? (action === "make" ? "Admin added" : "Admin removed"));
      } else {
        showToast(j.error ?? "Admin change failed", false);
      }
    } catch {
      showToast("Network error — admin change failed", false);
    }
    setAdminSaving(false);
    setAdminTarget(null);
  }

  async function viewCollegeId(studentId: string) {
    setViewingId(studentId);
    try {
      const res = await fetch(`/api/admin/students/${studentId}/college-id`, { headers: h() });
      const j = await res.json();
      if (j.success && j.data?.url) {
        window.open(j.data.url, "_blank", "noopener,noreferrer");
        window.open(j.data.url, "_blank", "noopener,noreferrer");
      } else {
        showToast(j.error ?? "Could not load College ID", false);
      }
    } catch {
      showToast("Could not load College ID", false);
    } finally {
      setViewingId(null);
    }
  }

  // Photo+Signature uses the same view pattern as College ID, via a
  // generic student-file endpoint keyed by field name.
  async function viewDocument(studentId: string, field: "college_id" | "photo_signature") {
    if (field === "college_id") return viewCollegeId(studentId);
    setViewingField(field);
    try {
      const res = await fetch(`/api/admin/students/${studentId}/document?field=${field}`, { headers: h() });
      const j = await res.json();
      if (j.success && j.data?.url) {
        window.open(j.data.url, "_blank", "noopener,noreferrer");
      } else {
        showToast(j.error ?? "Could not load document", false);
      }
    } catch {
      showToast("Could not load document", false);
    } finally {
      setViewingField(null);
    }
  }

  // Admin re-upload — used when a student sent their photo/signature over
  // WhatsApp and the admin needs to attach it to that student's record
  // directly, without the student re-doing registration.
  async function uploadDocument(studentId: string, field: "college_id" | "photo_signature", file: File) {
    setUploadingField(field);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("field", field);
      const res = await fetch(`/api/admin/students/${studentId}/upload`, {
        method: "POST", headers: h(), body: fd,
      });
      const j = await res.json();
      if (j.success) {
        const column = field === "college_id" ? "college_id_path" : "photo_signature_path";
        setStudents(prev => prev.map(s => s.id === studentId ? { ...s, [column]: j.data.storage_path } : s));
        setDocsStudent(prev => prev && prev.id === studentId ? { ...prev, [column]: j.data.storage_path } as Student : prev);
        showToast(`${field === "college_id" ? "College ID" : "Photo + Signature"} updated`);
      } else {
        showToast(j.error ?? "Upload failed", false);
      }
    } catch {
      showToast("Upload failed", false);
    } finally {
      setUploadingField(null);
    }
  }

  async function recheckSignature(studentId: string) {
    setCheckingSignature(true);
    try {
      const res = await fetch(`/api/admin/students/${studentId}/college-id-check`, { method: "POST", headers: h() });
      const j = await res.json();
      if (!j.success) { showToast(j.error ?? "Check failed", false); return; }
      if (!j.data.available) { showToast("AI check unavailable right now — try again shortly", false); return; }
      const flag = j.data.result;
      setStudents(prev => prev.map(s => s.id === studentId ? { ...s, college_id_ai_flag: flag } : s));
      setDocsStudent(prev => prev && prev.id === studentId ? { ...prev, college_id_ai_flag: flag } : prev);
      showToast(flag.hasSignature ? "Signature detected — looks good" : "Signature not detected on this ID");
    } catch {
      showToast("Network error while checking", false);
    } finally {
      setCheckingSignature(false);
    }
  }

  const inp = "w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300";

  // Incomplete/never-registered signups (abandoned mid-registration, or
  // just opened the link and never filled anything in) were previously
  // mixed in at the top of the same list as real, registered students —
  // cluttering the main view with entries that aren't actually students
  // yet. Split them into their own, collapsed-by-default section below.
  const registeredStudents = students.filter(s => s.is_profile_complete);
  const incompleteStudents = students.filter(s => !s.is_profile_complete);

  const renderCard = (s: Student, idx: number) => (
    <div key={s.id} className="bg-white rounded-2xl p-4 shadow-sm">
      <div className="flex justify-between items-start">
        <div>
          <p className="font-semibold text-sm">
            <span className="text-gray-300 font-normal mr-1.5 tabular-nums">{idx + 1}.</span>
            {s.full_name ?? (
              <>
                {s.full_name ?? "Unknown student"}
                <span className="ml-1.5 text-[10px] font-normal px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 align-middle">
                  not registered
                </span>
              </>
            )}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            {s.payment_order && (
              <span className="inline-flex items-center justify-center bg-blue-100 text-blue-700 text-[10px] font-black px-1.5 h-4 rounded-full mr-1.5 align-middle whitespace-nowrap">
                #{s.payment_order} of {s.batch_approved_total}
              </span>
            )}
            {s.college} • {s.roll_number ?? "-"} • {s.branch ?? "-"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded-full ${s.is_profile_complete ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}
            title="Registration status">
            {s.is_profile_complete ? "Registered" : "Incomplete"}
          </span>
          {/* Payment status — the thing an admin verifying by hand needs to see. */}
          {s.is_profile_complete && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${(PAY_BADGE[s.pay_status ?? "none"] ?? PAY_BADGE.none).cls}`}
              title="Payment status">
              {(PAY_BADGE[s.pay_status ?? "none"] ?? PAY_BADGE.none).label}
            </span>
          )}
          {s.role !== "student" && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">{s.role}</span>
          )}
        </div>
      </div>

      {/* Clean, single-line key facts — no wall of pills */}
      <div className="mt-2.5 space-y-1 text-xs text-gray-500">
        {s.phone && (
          <div className="flex items-center gap-2"><Phone size={12} strokeWidth={2} className="w-4 text-center text-gray-400" /><span>{s.phone}</span></div>
        )}
        {s.father_name && (
          <div className="flex items-center gap-2"><Users2 size={12} strokeWidth={2} className="w-4 text-center text-gray-400" /><span>{s.father_name}</span></div>
        )}
        <div className="flex items-center gap-2">
          <ClipboardList size={12} strokeWidth={2} className="w-4 text-center text-gray-400" />
          <span>{s.batches ? s.batches.name : <span className="text-gray-300">No batch assigned</span>}</span>
        </div>
        {s.utr_number && (
          <div className="flex items-center gap-2">
            <Receipt size={12} strokeWidth={2} className="w-4 text-center text-gray-400" />
            <span>UTR: <span className="font-mono text-gray-700">{s.utr_number}</span></span>
          </div>
        )}
        {s.created_at && (
          <div className="flex items-center gap-2">
            <CalendarDays size={12} strokeWidth={2} className="w-4 text-center text-gray-400" />
            <span>Joined {new Date(s.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
          </div>
        )}
      </div>

      {/* Receipt shortcut — opens the payment detail (UTR + screenshot + approve).
          Only when the student actually submitted a payment. Highlighted when it
          is still awaiting review, since that's what needs the admin's action. */}
      {s.is_profile_complete && s.payment_id && s.pay_status && s.pay_status !== "none" && (
        <button onClick={() => router.push(`/admin/payments/${s.payment_id}`)}
          className={`w-full text-sm py-2 rounded-xl font-semibold mt-3 ${
            s.pay_status === "submitted" || s.pay_status === "reupload_requested"
              ? "bg-amber-500 text-white"
              : "bg-gray-100 text-gray-700"}`}>
          <span className="inline-flex items-center gap-1.5"><Receipt size={13} strokeWidth={2} /> {s.pay_status === "submitted" || s.pay_status === "reupload_requested"
            ? "Verify payment (UTR + screenshot)"
            : "View payment receipt"}</span>
        </button>
      )}

      <div className="flex gap-2 mt-3">
        {s.is_profile_complete && (
          <>
            <button onClick={() => openEdit(s)}
              className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-blue-50 text-blue-600 py-2 rounded-xl font-medium">
              <Pencil size={13} strokeWidth={2} /> Edit
            </button>
            <button onClick={() => setDocsStudent(s)}
              className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-indigo-50 text-indigo-600 py-2 rounded-xl font-medium relative">
              <FileText size={13} strokeWidth={2} /> Docs
              {(!s.college_id_path || s.college_id_ai_flag?.hasSignature === false) && (
                <span
                  title={!s.college_id_path ? "College ID not uploaded" : "AI check: signature not visible on College ID"}
                  className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border-2 border-white"
                />
              )}
            </button>
          </>
        )}
        {!["admin", "super_admin"].includes(s.role) ? (
          <button onClick={() => setDeleteId(s.id)}
            className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-red-50 text-red-600 py-2 rounded-xl font-medium">
            <Trash2 size={13} strokeWidth={2} /> Delete
          </button>
        ) : (
          <div className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-gray-50 text-gray-300 py-2 rounded-xl font-medium"><Lock size={12} strokeWidth={2} /> Admin</div>
        )}
      </div>

      {/* Make as Admin — super_admin only, on every person's card.
          Max 2 admins per batch, enforced by /api/admin/users/make-admin. */}
      {isSuperAdmin && s.role !== "super_admin" && (s.role === "admin" || (adminCounts[s.batch_id ?? ""] ?? 0) < 2) && (
        <button onClick={() => setAdminTarget(s)}
          className={`w-full flex items-center justify-center gap-1.5 text-sm py-2 rounded-xl font-medium mt-2 ${
            s.role === "admin"
              ? "bg-purple-50 text-purple-400"
              : "bg-purple-600 text-white"}`}>
          <ShieldCheck size={13} strokeWidth={2} /> {s.role === "admin" ? "Remove admin" : "Make as Admin"}
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      <div className="bg-blue-600 text-white px-4 pt-10 pb-4">
        <button onClick={() => router.back()} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.15)", border:"1.5px solid rgba(255,255,255,0.25)", borderRadius:14, padding:"8px 16px 8px 10px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", marginBottom:18, backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">Students</h1>
            <p className="text-sm opacity-80">{colleges.find(c => c.id === college)?.name ?? college} · {total} students</p>
          </div>
          {/* Spot registrations: paid in person, details sent over WhatsApp,
              never went through the app. Without this they exist nowhere.
              super_admin only. */}
          {isSuperAdmin && (
            <button
              onClick={() => setAddOpen(true)}
              className="shrink-0 inline-flex items-center gap-1.5 bg-white/15 border border-white/25 rounded-xl px-3 py-2 text-sm font-semibold text-white"
            >
              <UserPlus size={15} strokeWidth={2.2} /> Add
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-3 space-y-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, roll, phone…"
          className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none" />

        {/* Level 1: College — pick one, the roster shows only that college.
            No "All" option: the page never shows a grand total. */}
        <div className="flex gap-2">
          {colleges.map(c => ({ value: c.id, label: c.name })).map(opt => (
            <button
              key={opt.value}
              onClick={() => setCollege(opt.value)}
              className={`flex-1 text-sm font-semibold rounded-xl px-3 py-2 border transition-colors ${
                college === opt.value
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-200"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Payment status — like a payment app's transaction filter */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4" style={{ scrollbarWidth: "none" }}>
          {[
            { value: "",         label: "All Payments", Icon: CreditCard },
            { value: "paid",     label: "Paid",          Icon: Check },
            { value: "failed",   label: "Failed",        Icon: X },
            { value: "not_paid", label: "Not Paid",      Icon: AlertTriangle },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setPayStatus(opt.value)}
              className={`flex-shrink-0 flex items-center gap-1.5 text-xs font-semibold rounded-full px-3 py-1.5 border transition-colors whitespace-nowrap ${
                payStatus === opt.value
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-600 border-gray-200"
              }`}
            >
              <opt.Icon size={12} strokeWidth={2} />
              {opt.label}
            </button>
          ))}
        </div>

        {/* Level 2: Batch — only shown once a specific college is picked,
            scoped to that college's real batches. Selecting a college
            alone still shows every batch under it combined (unchanged
            behavior); picking a batch here narrows to that batch only. */}
        {college && (
          <select
            value={batchId}
            onChange={e => setBatchId(e.target.value)}
            className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm"
          >
            <option value="">All {college} batches</option>
            {batches.map(b => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        )}

        {/* Batch-level payment counter — whole-batch breakdown, not affected by
            the roster filters below it. */}
        {batchId && batchSummary && (
          <div className="bg-white border border-gray-100 rounded-2xl p-3 shadow-sm">
            <div className="grid grid-cols-4 gap-2 text-center">
              <div>
                <p className="text-lg font-black text-gray-900 leading-none">{batchSummary.registered}</p>
                <p className="text-[10px] text-gray-400 font-semibold mt-1">Registered</p>
              </div>
              <div>
                <p className="text-lg font-black text-green-600 leading-none">{batchSummary.paid}</p>
                <p className="text-[10px] text-gray-400 font-semibold mt-1">Paid</p>
              </div>
              <div>
                <p className="text-lg font-black text-amber-600 leading-none">{batchSummary.awaiting_review}</p>
                <p className="text-[10px] text-gray-400 font-semibold mt-1">To verify</p>
              </div>
              <div>
                <p className="text-lg font-black text-gray-400 leading-none">{batchSummary.not_paid}</p>
                <p className="text-[10px] text-gray-400 font-semibold mt-1">Not paid</p>
              </div>
            </div>
            <div className="mt-2.5 pt-2.5 border-t border-gray-100">
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className="text-gray-500 font-medium">Petition seats</span>
                <span className={`font-bold ${batchSummary.registered >= batchSummary.min_seats ? "text-green-600" : "text-amber-600"}`}>
                  {batchSummary.registered} / {batchSummary.min_seats}
                  {batchSummary.registered < batchSummary.min_seats && ` · ${batchSummary.seats_remaining} to go`}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, Math.round((batchSummary.registered / batchSummary.min_seats) * 100))}%`,
                    background: batchSummary.registered >= batchSummary.min_seats
                      ? "linear-gradient(90deg,#22c55e,#16a34a)"
                      : "linear-gradient(90deg,#fbbf24,#f59e0b)",
                  }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className={`mx-4 mb-2 text-sm p-3 rounded-xl text-center ${toast.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
          {toast.msg}
        </div>
      )}

      <div className="px-4 space-y-3">
        {loading ? <p className="text-center text-gray-400 py-8 text-sm">Loading…</p> :
          students.length === 0 ? <div className="text-center py-12"><p className="text-gray-400">No students found</p></div> :
          <>
            {registeredStudents.map((s, i) => renderCard(s, i))}

            {incompleteStudents.length > 0 && (
              <div className="pt-2">
                <button
                  onClick={() => setIncompleteOpen(o => !o)}
                  className="w-full flex items-center justify-between bg-gray-100 rounded-2xl px-4 py-3 text-sm font-semibold text-gray-500"
                >
                  <span className="inline-flex items-center gap-1.5"><AlertTriangle size={13} strokeWidth={2} /> {incompleteStudents.length} Incomplete / Not Registered</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                    style={{ transform: incompleteOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {incompleteOpen && (
                  <div className="space-y-3 mt-3">
                    {incompleteStudents.map((s, i) => renderCard(s, i))}
                  </div>
                )}
              </div>
            )}
          </>
        }
        {!loading && students.length < total && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full py-3 rounded-xl bg-gray-100 text-gray-600 text-sm font-semibold disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : `Load more (${students.length} of ${total})`}
          </button>
        )}
      </div>

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
          <div className="bg-white w-full rounded-t-2xl p-5 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-1">
              <h2 className="font-bold text-lg">Edit Student</h2>
              <button onClick={() => setEditing(null)} className="text-gray-400"><X size={18} strokeWidth={2} /></button>
            </div>
            <div><label className="text-xs text-gray-400 font-medium block mb-1">Full Name</label>
              <input className={inp} value={editData.full_name ?? ""} onChange={e => setEditData(p => ({ ...p, full_name: e.target.value }))} /></div>
            <div><label className="text-xs text-gray-400 font-medium block mb-1">Phone</label>
              <input className={inp} value={editData.phone ?? ""} onChange={e => setEditData(p => ({ ...p, phone: e.target.value }))} /></div>
            <div><label className="text-xs text-gray-400 font-medium block mb-1">College</label>
              <select className={inp} value={editData.college ?? ""} onChange={e => setEditData(p => ({ ...p, college: e.target.value }))}>
                <option value="">Select</option>
                {colleges.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <div><label className="text-xs text-gray-400 font-medium block mb-1">Branch</label>
              <input className={inp} value={editData.branch ?? ""} onChange={e => setEditData(p => ({ ...p, branch: e.target.value }))} /></div>
            <div><label className="text-xs text-gray-400 font-medium block mb-1">Year</label>
              <input className={inp} type="number" min={1} max={4} value={editData.year ?? ""}
                onChange={e => setEditData(p => ({ ...p, year: Number(e.target.value) }))} /></div>
            <div><label className="text-xs text-gray-400 font-medium block mb-1">Roll Number</label>
              <input className={inp} value={editData.roll_number ?? ""} onChange={e => setEditData(p => ({ ...p, roll_number: e.target.value }))} /></div>
            <div>
              <label className="text-xs text-gray-400 font-medium block mb-1">Home Address</label>
              <textarea className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none"
                rows={3} value={editData.home_address ?? ""}
                onChange={e => setEditData(p => ({ ...p, home_address: e.target.value }))}
                placeholder="Full address including PIN code" />
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setEditing(null)} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-semibold">Cancel</button>
              <button onClick={saveEdit} disabled={saving} className="flex-1 bg-blue-600 text-white py-3 rounded-xl font-semibold disabled:opacity-60">
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Docs Sheet — view or replace College ID / Photo+Signature */}
      {docsStudent && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end" onClick={() => setDocsStudent(null)}>
          <div className="bg-white w-full rounded-t-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-1">
              <div>
                <h2 className="font-bold text-lg">Documents</h2>
                <p className="text-xs text-gray-400">{docsStudent.full_name}</p>
              </div>
              <button onClick={() => setDocsStudent(null)} className="text-gray-400"><X size={18} strokeWidth={2} /></button>
            </div>

            {([
              { field: "college_id" as const,      label: "College ID Card",      path: docsStudent.college_id_path },
              { field: "photo_signature" as const, label: "Photo + Signature",    path: docsStudent.photo_signature_path },
            ]).map(doc => (
              <div key={doc.field} className="border border-gray-100 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-gray-700">{doc.label}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${doc.path ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                    {doc.path ? "Uploaded" : "Missing"}
                  </span>
                </div>
                {doc.field === "college_id" && docsStudent.college_id_ai_flag?.hasSignature === false && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5 mb-2 flex items-center gap-1.5">
                    <AlertTriangle size={12} strokeWidth={2} className="flex-shrink-0" />
                    AI check: signature not visible on this ID — {docsStudent.college_id_ai_flag.notes ?? "student may need to re-upload with signature"}
                  </p>
                )}
                {doc.field === "college_id" && docsStudent.college_id_ai_flag?.hasSignature === true && (
                  <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg px-2.5 py-1.5 mb-2 flex items-center gap-1.5">
                    <Check size={12} strokeWidth={2} className="flex-shrink-0" />
                    AI check: signature detected on this ID
                  </p>
                )}

                <div className="flex gap-2">
                  {doc.path && (
                    <button
                      onClick={() => viewDocument(docsStudent.id, doc.field)}
                      disabled={viewingId === docsStudent.id || viewingField === doc.field}
                      className="flex-1 flex items-center justify-center gap-1.5 text-sm bg-indigo-50 text-indigo-600 py-2.5 rounded-xl font-medium disabled:opacity-60"
                    >
                      {(viewingId === docsStudent.id || viewingField === doc.field) ? "Opening…" : <><Eye size={14} strokeWidth={2} /> View</>}
                    </button>
                  )}

                  <label className={`flex-1 flex items-center justify-center gap-1.5 text-sm py-2.5 rounded-xl font-medium text-center cursor-pointer ${
                    uploadingField === doc.field ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-600"
                  }`}>
                    {uploadingField === doc.field ? "Uploading…" : doc.path ? <><RefreshCw size={14} strokeWidth={2} /> Replace</> : <><Upload size={14} strokeWidth={2} /> Upload</>}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                      className="hidden"
                      disabled={uploadingField === doc.field}
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) uploadDocument(docsStudent.id, doc.field, file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>

                {doc.field === "college_id" && doc.path && (
                  <button
                    onClick={() => recheckSignature(docsStudent.id)}
                    disabled={checkingSignature}
                    className="w-full flex items-center justify-center gap-1.5 text-xs bg-teal-50 text-teal-700 border border-teal-200 py-2 rounded-xl font-semibold mt-2 disabled:opacity-60"
                  >
                    {checkingSignature ? "Checking…" : <><Search size={12} strokeWidth={2} /> {docsStudent.college_id_ai_flag ? "Recheck signature with AI" : "Check signature with AI"}</>}
                  </button>
                )}
              </div>
            ))}

            <p className="text-xs text-gray-400 text-center pt-1">
              Use "Replace" or "Upload" if a student sent their document over WhatsApp
              and can't complete it themselves right now.
            </p>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm text-center space-y-4">
            <div className="w-14 h-14 mx-auto bg-red-100 rounded-full flex items-center justify-center"><AlertTriangle size={24} strokeWidth={2} className="text-red-600" /></div>
            <h2 className="font-bold text-lg">Delete Student?</h2>
            <p className="text-sm text-gray-500">This permanently deletes all their data. Cannot be undone.</p>
            <textarea
              value={deleteReason}
              onChange={e => setDeleteReason(e.target.value)}
              placeholder="Reason for removal (shown to the student)"
              rows={3}
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 text-left focus:outline-none focus:ring-2 focus:ring-red-200"
            />
            <div className="flex gap-2">
              <button onClick={() => { setDeleteId(null); setDeleteReason(""); }} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-semibold">Cancel</button>
              <button onClick={confirmDelete} disabled={deleting || !deleteReason.trim()}
                className="flex-1 bg-red-600 text-white py-3 rounded-xl font-semibold disabled:opacity-60">
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Make / Remove Admin Confirmation */}
      {adminTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm text-center space-y-4">
            <div className="w-14 h-14 mx-auto bg-purple-100 rounded-full flex items-center justify-center"><ShieldCheck size={24} strokeWidth={2} className="text-purple-600" /></div>
            <h2 className="font-bold text-lg">{adminTarget.role === "admin" ? "Remove Admin?" : "Make as Admin?"}</h2>
            <p className="text-sm text-gray-500">
              {adminTarget.role === "admin"
                ? `${adminTarget.full_name} will go back to a normal student account and lose admin access to ${adminTarget.batches?.name ?? "their batch"}.`
                : `${adminTarget.full_name} will become an admin of ${adminTarget.batches?.name ?? "their batch"} and can log in with their phone number. Max 2 admins per batch.`}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setAdminTarget(null)} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-xl font-semibold">Cancel</button>
              <button onClick={confirmAdminChange} disabled={adminSaving}
                className="flex-1 bg-purple-600 text-white py-3 rounded-xl font-semibold disabled:opacity-60">
                {adminSaving ? "Saving…" : adminTarget.role === "admin" ? "Remove admin" : "Make admin"}
              </button>
            </div>
          </div>
        </div>
      )}

      <AddSpotStudentSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(msg, ok) => { showToast(msg, ok); load(); }}
      />
    </div>
  );
}

export default function AdminStudents() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <AdminStudentsInner />
    </Suspense>
  );
}
