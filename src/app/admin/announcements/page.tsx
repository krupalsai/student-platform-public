"use client";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { X, School, Megaphone, Loader2 } from "lucide-react";

type Batch = { id: string; name: string; college: string };
type Ann = {
  id: string; title: string; body: string;
  college: string; batch_id: string | null; priority: string;
  created_at: string; expires_at?: string | null;
  attachment_url?: string | null; attachment_name?: string | null;
};

const PRIORITY_STYLE: Record<string, string> = {
  urgent: "bg-red-100 text-red-700",
  normal: "bg-gray-100 text-gray-600",
};
const COLLEGE_STYLE: Record<string, string> = {
  all:   "bg-blue-100 text-blue-700",
  GNIT:  "bg-blue-100 text-blue-700",
  GNITC: "bg-emerald-100 text-emerald-700",
};

export default function AdminAnnouncements() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [list, setList]         = useState<Ann[]>([]);
  const [batches, setBatches]   = useState<Batch[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toast, setToast]       = useState<{ msg: string; ok: boolean } | null>(null);
  const [seenCounts, setSeenCounts] = useState<Record<string, number>>({});
  const [form, setForm] = useState({
    title: "", body: "", college: "all", batch_id: "",
    priority: "normal", expires_at: "",
    attachment_url: "", attachment_name: "",
    targetValue: "__all__",
  });
  // 2-step college → batch picker
  const [targetCollege, setTargetCollege] = useState<string>("all");
  const [targetStep, setTargetStep] = useState<1|2>(1);
  // Fetched, not a hardcoded all/GNIT/GNITC union — the backend
  // (services/announcements.ts) already validates college against the live
  // colleges table; a fixed list here just meant BIET could never be picked
  // in the UI even though sending to it already worked. Same trap as items
  // #101/#107/#114/#118.
  const [colleges, setColleges] = useState<{ id: string; name: string }[]>([
    { id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" },
  ]);

  const h = () => ({
    Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}`,
  });
  const hj = () => ({
    ...h(),
    "Content-Type": "application/json",
  });

  useEffect(() => {
    load();
    loadBatches();
    fetch("/api/settings/colleges").then(r => r.json()).then(j => {
      if (Array.isArray(j.data) && j.data.length) setColleges(j.data);
    }).catch(() => {});
  }, []);

  function showToast(msg: string, ok: boolean = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  function load() {
    setLoading(true);
    fetch("/api/admin/announcements", { headers: h() })
      .then(r => r.json())
      .then(j => { setList(j.data ?? []); setLoading(false); });
  }

  function loadBatches() {
    fetch("/api/admin/batches", { headers: h() })
      .then(r => r.json())
      .then(j => setBatches(j.data ?? []));
  }

  // Seen counts — how many distinct students actually viewed each card.
  // student_events only starts recording these after this ships, so a card
  // published earlier legitimately shows 0 until students open it again.
  useEffect(() => {
    if (list.length === 0) return;
    const ids = list.map(a => a.id).join(",");
    fetch(`/api/admin/announcements/seen?ids=${encodeURIComponent(ids)}`, { headers: h() })
      .then(r => r.json())
      .then(j => { if (j.success && j.data) setSeenCounts(j.data); })
      .catch(() => {});
  }, [list]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/admin/announcements/upload", {
      method: "POST",
      headers: h(),
      body: fd,
    });
    const j = await res.json();
    setUploading(false);
    if (j.success) {
      setForm(f => ({ ...f, attachment_url: j.data.url, attachment_name: j.data.name }));
      showToast("File uploaded");
    } else {
      showToast(j.error ?? "Upload failed", false);
    }
  }

  function removeAttachment() {
    setForm(f => ({ ...f, attachment_url: "", attachment_name: "" }));
    if (fileRef.current) fileRef.current.value = "";
  }

  const COLLEGE_TARGET_PREFIX = "__COLLEGE__";

  function handleTargetChange(val: string) {
    if (val === "__all__") {
      setForm(f => ({ ...f, targetValue: val, batch_id: "", college: "all" }));
    } else if (val.startsWith(COLLEGE_TARGET_PREFIX)) {
      // All students of one college — no specific batch, college scoped.
      // A dynamic prefix, not one literal sentinel per college (was
      // __GNIT__/__GNITC__ only) — same trap as items #101/#107/#114/#118.
      const collegeId = val.slice(COLLEGE_TARGET_PREFIX.length);
      setForm(f => ({ ...f, targetValue: val, batch_id: "", college: collegeId }));
    } else {
      // Specific batch UUID
      const b = batches.find(x => x.id === val);
      setForm(f => ({ ...f, targetValue: val, batch_id: val, college: b?.college ?? "all" }));
    }
  }

  async function create() {
    if (!form.title.trim() || !form.body.trim()) {
      showToast("Title and message are required", false);
      return;
    }
    setSaving(true);
    const payload: Record<string, any> = {
      title:    form.title.trim(),
      body:     form.body.trim(),
      college:  form.college,
      priority: form.priority,
      batch_id: form.batch_id || null,
    };
    if (form.expires_at) payload.expires_at = new Date(form.expires_at).toISOString();
    if (form.attachment_url)  payload.attachment_url  = form.attachment_url;
    if (form.attachment_name) payload.attachment_name = form.attachment_name;

    const res = await fetch("/api/admin/announcements", {
      method: "POST", headers: hj(), body: JSON.stringify(payload),
    });
    const j = await res.json();
    setSaving(false);
    if (j.success) {
      setList(prev => [j.data, ...prev]);
      setShowNew(false);
      setForm({ title: "", body: "", college: "all", batch_id: "", priority: "normal",
                expires_at: "", attachment_url: "", attachment_name: "", targetValue: "__all__" });
      if (fileRef.current) fileRef.current.value = "";
      showToast("Announcement published");
    } else {
      showToast(j.error ?? "Failed", false);
    }
  }

  async function del(id: string) {
    setDeleting(id);
    const res = await fetch(`/api/admin/announcements/${id}`, {
      method: "DELETE", headers: h(),
    });
    const j = await res.json();
    setDeleting(null);
    if (j.success) {
      setList(prev => prev.filter(a => a.id !== id));
      showToast("Deleted");
    } else {
      showToast(j.error ?? "Failed", false);
    }
  }

  function batchLabel(a: Ann) {
    if (a.batch_id) {
      const b = batches.find(x => x.id === a.batch_id);
      return b ? b.name : "Specific Batch";
    }
    if (a.college === "all")   return "All Students";
    if (a.college === "GNIT")  return "All GNIT";
    if (a.college === "GNITC") return "All GNITC";
    return a.college;
  }

  function batchBadgeStyle(a: Ann) {
    if (a.batch_id) return "bg-amber-100 text-amber-700";
    return COLLEGE_STYLE[a.college] ?? COLLEGE_STYLE.all;
  }

  const inp = "w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300";

  const targetCollegeBatches = batches.filter(b => b.college === targetCollege);

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-600 to-indigo-700 px-4 pt-10 pb-5">
        <button onClick={() => router.back()} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.15)", border:"1.5px solid rgba(255,255,255,0.25)", borderRadius:14, padding:"8px 16px 8px 10px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", marginBottom:18, backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-white text-xl font-bold">Announcements</h1>
            <p className="text-blue-200 text-xs mt-0.5">{list.length} active</p>
          </div>
          <button
            onClick={() => setShowNew(!showNew)}
            className="bg-white/20 text-white text-sm font-semibold px-4 py-2 rounded-full"
          >
            {showNew ? <span className="inline-flex items-center gap-1"><X size={13} strokeWidth={2} /> Cancel</span> : "+ New"}
          </button>
        </div>
      </div>

      <div className="px-4 mt-4 space-y-3">
        {/* Toast */}
        {toast && (
          <div className={`text-sm p-3 rounded-xl text-center font-medium ${toast.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
            {toast.msg}
          </div>
        )}

        {/* New announcement form */}
        {showNew && (
          <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
            <p className="font-semibold text-sm text-gray-800">New Announcement</p>

            {/* Title */}
            <div>
              <label className="text-xs text-gray-400 font-medium block mb-1">Title *</label>
              <input
                className={inp}
                placeholder="e.g. Court Order — October Session"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              />
            </div>

            {/* Message */}
            <div>
              <label className="text-xs text-gray-400 font-medium block mb-1">Message *</label>
              <textarea
                className={`${inp} resize-none`}
                rows={3}
                placeholder="Write the announcement message…"
                value={form.body}
                onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              />
            </div>

            {/* Target — 2 step: college first, then batch */}
            <div>
              <label className="text-xs text-gray-400 font-medium block mb-2">Target *</label>

              {/* Step 1: College */}
              <p className="text-xs font-semibold text-gray-500 mb-1.5">Step 1 — Select college</p>
              <div className="flex gap-2 mb-3 flex-wrap">
                {["all", ...colleges.map(c => c.id)].map(c => (
                  <button key={c} type="button"
                    onClick={() => {
                      setTargetCollege(c);
                      setTargetStep(c === "all" ? 1 : 2);
                      handleTargetChange(c === "all" ? "__all__" : COLLEGE_TARGET_PREFIX + c);
                    }}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-colors border ${
                      targetCollege === c
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-gray-50 text-gray-600 border-gray-200"
                    }`}>
                    <span className="inline-flex items-center gap-1.5">{c === "all" ? <Megaphone size={12} strokeWidth={2} /> : <School size={12} strokeWidth={2} />} {c === "all" ? "All" : c}</span>
                  </button>
                ))}
              </div>

              {/* Step 2: Batch (only if college selected) */}
              {targetCollege !== "all" && (
                <>
                  <p className="text-xs font-semibold text-gray-500 mb-1.5">Step 2 — Select batch</p>
                  <div className="flex flex-col gap-1.5">
                    <button type="button"
                      onClick={() => { setTargetStep(2); handleTargetChange(COLLEGE_TARGET_PREFIX + targetCollege); }}
                      className={`w-full text-left px-4 py-3 rounded-xl text-sm font-semibold border transition-colors ${
                        form.targetValue === COLLEGE_TARGET_PREFIX + targetCollege
                          ? "bg-blue-50 border-blue-300 text-blue-700"
                          : "bg-gray-50 border-gray-200 text-gray-700"
                      }`}>
                      <span className="inline-flex items-center gap-1.5"><School size={13} strokeWidth={2} /> All {targetCollege} students</span>
                    </button>
                    {targetCollegeBatches.map(b => (
                      <button key={b.id} type="button"
                        onClick={() => { setTargetStep(2); handleTargetChange(b.id); }}
                        className={`w-full text-left px-4 py-3 rounded-xl text-sm font-semibold border transition-colors ${
                          form.targetValue === b.id
                            ? "bg-amber-50 border-amber-300 text-amber-700"
                            : "bg-gray-50 border-gray-200 text-gray-600"
                        }`}>
                        {b.name}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <p className="text-xs text-gray-400 mt-2">
                {form.batch_id
                  ? `→ Batch-specific (${form.college})`
                  : form.college === "all"
                    ? "→ Everyone sees this"
                    : `→ All ${form.college} students`
                }
              </p>
            </div>

            {/* Priority + Expires */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 font-medium block mb-1">Priority</label>
                <select className={inp} value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                  <option value="normal">Normal</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 font-medium block mb-1">Expires (optional)</label>
                <input type="datetime-local" className={inp} value={form.expires_at}
                  onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} />
              </div>
            </div>

            {/* File attachment */}
            <div>
              <label className="text-xs text-gray-400 font-medium block mb-1">
                Attachment — PDF or DOCX (optional, max 10 MB)
              </label>
              {form.attachment_url ? (
                <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-3 py-2.5">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                  </svg>
                  <span className="text-xs text-green-700 font-medium flex-1 truncate">{form.attachment_name}</span>
                  <button
                    onClick={removeAttachment}
                    className="text-red-400 ml-1 flex-shrink-0"
                  ><X size={14} strokeWidth={2} /></button>
                </div>
              ) : (
                <div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    className="hidden"
                    id="ann-file-input"
                    onChange={handleFileChange}
                  />
                  <label
                    htmlFor="ann-file-input"
                    className={`flex items-center justify-center gap-2 w-full border-2 border-dashed border-gray-200 rounded-xl py-3 cursor-pointer text-sm text-gray-400 font-medium hover:border-blue-300 hover:text-blue-400 transition-colors ${uploading ? "opacity-60 pointer-events-none" : ""}`}
                  >
                    {uploading ? (
                      <>
                        <Loader2 size={14} strokeWidth={2} className="animate-spin" /> Uploading…
                      </>
                    ) : (
                      <>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                          <polyline points="17 8 12 3 7 8"/>
                          <line x1="12" y1="3" x2="12" y2="15"/>
                        </svg>
                        Tap to upload PDF or DOCX
                      </>
                    )}
                  </label>
                </div>
              )}
            </div>

            <button
              onClick={create}
              disabled={saving || uploading}
              className="w-full bg-blue-600 text-white py-3 rounded-xl font-semibold text-sm disabled:opacity-60"
            >
              {saving ? "Publishing…" : <span className="inline-flex items-center gap-1.5 justify-center"><Megaphone size={14} strokeWidth={2} /> Publish Announcement</span>}
            </button>
          </div>
        )}

        {/* List */}
        {loading ? (
          <p className="text-center text-gray-400 py-8 text-sm">Loading…</p>
        ) : list.length === 0 ? (
          <div className="text-center py-16">
            <Megaphone size={30} strokeWidth={1.6} className="mx-auto mb-3 text-gray-300" />
            <p className="text-gray-500 font-semibold">No announcements yet</p>
            <p className="text-gray-400 text-sm mt-1">Tap + New to publish one</p>
          </div>
        ) : list.map(a => (
          <div key={a.id} className="bg-white rounded-2xl shadow-sm overflow-hidden">
            {a.priority === "urgent" && <div className="h-1 bg-red-500" />}
            <div className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${PRIORITY_STYLE[a.priority] ?? PRIORITY_STYLE.normal}`}>
                      {a.priority === "urgent" ? "Urgent" : "Normal"}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${batchBadgeStyle(a)}`}>
                      {batchLabel(a)}
                    </span>
                  </div>
                  <p className="font-bold text-gray-800 text-sm">{a.title}</p>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">{a.body}</p>

                  {a.attachment_url && (
                    <a
                      href={a.attachment_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 mt-2 bg-blue-50 text-blue-600 text-xs font-semibold px-3 py-1.5 rounded-lg"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                      </svg>
                      {a.attachment_name ?? "View Attachment"}
                    </a>
                  )}

                  <p className="text-xs text-gray-300 mt-2">
                    {new Date(a.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    {a.expires_at && ` · Expires ${new Date(a.expires_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
                    {seenCounts[a.id] !== undefined && (
                      <span className="text-gray-500 font-semibold"> · 👁 {seenCounts[a.id]} seen</span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => del(a.id)}
                  disabled={deleting === a.id}
                  className="text-red-400 text-xs bg-red-50 px-3 py-1.5 rounded-xl font-medium flex-shrink-0 disabled:opacity-50"
                >
                  {deleting === a.id ? "…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
