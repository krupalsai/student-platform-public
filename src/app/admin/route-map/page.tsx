"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, FileText } from "lucide-react";

type Attachment = {
  id: string; college: string; title: string; description: string | null;
  file_url: string; file_name: string | null; file_type: string;
  kind: string; step_id: number | null; sort_order: number; created_at: string;
};

const COLLEGE_STYLE: Record<string, string> = {
  all:   "bg-blue-100 text-blue-700",
  GNIT:  "bg-blue-100 text-blue-700",
  GNITC: "bg-emerald-100 text-emerald-700",
};

// Mirrors the hardcoded GNIT steps in components/RouteMap.tsx. Pinning is
// optional — an unpinned attachment shows in the Route Map's own section at
// the end, which is what "I just forgot a photo" usually wants.
const GNIT_STEPS = [
  { id: 1, label: "1 · Court Order" },
  { id: 2, label: "2 · Required Documents" },
  { id: 3, label: "3 · No Due Process" },
  { id: 4, label: "4 · PC & CMM" },
  { id: 5, label: "5 · Final Certificates" },
];

export default function AdminRouteMap() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [list, setList]         = useState<Attachment[]>([]);
  const [loading, setLoading]   = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toast, setToast]       = useState("");
  const [file, setFile]         = useState<File | null>(null);
  const [preview, setPreview]   = useState<string>("");
  const [form, setForm] = useState({ title: "", description: "", college: "GNIT", step_id: "" });
  // Fetched, not hardcoded — a fixed GNIT/GNITC list here silently made
  // uploading a Route Map file for any later college impossible. Same trap
  // as items #101/#107/#114/#118.
  const [colleges, setColleges] = useState<{ id: string; name: string }[]>([
    { id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" },
  ]);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3500); };

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/route-map", { headers: h() });
      if (res.status === 403) { router.push("/admin"); return; }
      const json = await res.json();
      setList(json.success ? json.data : []);
    } catch { showToast("Could not load attachments."); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => {
    fetch("/api/settings/colleges").then(r => r.json()).then(j => {
      if (Array.isArray(j.data) && j.data.length) setColleges(j.data);
    }).catch(() => {});
  }, []);

  // Local preview so the admin sees what they picked before uploading — the
  // common mistake this page exists to fix is uploading the wrong photo.
  const pickFile = (f: File | null) => {
    setFile(f);
    setPreview(p => { if (p) URL.revokeObjectURL(p); return f && f.type.startsWith("image/") ? URL.createObjectURL(f) : ""; });
    if (f && !form.title) setForm(s => ({ ...s, title: f.name.replace(/\.[^.]+$/, "") }));
  };

  const upload = async () => {
    if (!file) { showToast("Choose a photo or file first."); return; }
    if (!form.title.trim()) { showToast("Give it a title."); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", form.title.trim());
      fd.append("description", form.description.trim());
      fd.append("college", form.college);
      if (form.step_id) fd.append("step_id", form.step_id);

      const res = await fetch("/api/admin/route-map", { method: "POST", headers: h(), body: fd });
      const json = await res.json();
      if (!json.success) { showToast(json.error ?? "Upload failed."); return; }

      setList(l => [...l, json.data]);
      pickFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setForm({ title: "", description: "", college: form.college, step_id: "" });
      showToast("Uploaded — students can see it now.");
    } catch { showToast("Upload failed. Please try again."); }
    finally { setUploading(false); }
  };

  const remove = async (a: Attachment) => {
    if (!confirm(`Remove "${a.title}" from the Route Map?`)) return;
    setDeleting(a.id);
    try {
      const res = await fetch(`/api/admin/route-map/${a.id}`, { method: "DELETE", headers: h() });
      const json = await res.json();
      if (!json.success) { showToast(json.error ?? "Could not remove it."); return; }
      setList(l => l.filter(x => x.id !== a.id));
      showToast("Removed.");
    } catch { showToast("Could not remove it."); }
    finally { setDeleting(null); }
  };

  const grouped = [...colleges.map(c => c.id), "all"]
    .map(c => ({ college: c, items: list.filter(a => a.college === c) }))
    .filter(g => g.items.length > 0);

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="bg-white border-b px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => router.push("/admin")} className="text-gray-500"><ChevronLeft size={22} strokeWidth={2} /></button>
        <div>
          <h1 className="text-lg font-bold text-gray-900">Route Map Files</h1>
          <p className="text-xs text-gray-500">Photos & documents students see in their Route Map</p>
        </div>
      </div>

      {toast && (
        <div className="mx-4 mt-3 rounded-xl bg-gray-900 text-white text-sm px-4 py-3">{toast}</div>
      )}

      {/* ── Upload ─────────────────────────────────────────────────────── */}
      <div className="m-4 bg-white rounded-2xl border p-4">
        <p className="font-bold text-gray-900 text-sm mb-3">Add a photo or file</p>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.doc,.docx"
          onChange={e => pickFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700"
        />
        <p className="text-[11px] text-gray-400 mt-1.5">JPG, PNG, WEBP, PDF or DOCX · up to 10 MB</p>

        {preview && (
          <img src={preview} alt="Selected" className="mt-3 w-full max-h-64 object-contain rounded-xl border bg-gray-50" />
        )}
        {file && !preview && (
          <p className="mt-3 text-sm text-gray-700 bg-gray-50 border rounded-xl px-3 py-2 flex items-center gap-2"><FileText size={14} strokeWidth={2} /> {file.name}</p>
        )}

        <input
          value={form.title}
          onChange={e => setForm(s => ({ ...s, title: e.target.value }))}
          placeholder="Title — e.g. HOD letter format"
          className="mt-3 w-full rounded-xl border px-3 py-2.5 text-sm"
        />
        <textarea
          value={form.description}
          onChange={e => setForm(s => ({ ...s, description: e.target.value }))}
          placeholder="Short instruction for students (optional)"
          rows={2}
          className="mt-2 w-full rounded-xl border px-3 py-2.5 text-sm"
        />

        <div className="mt-2 grid grid-cols-2 gap-2">
          <select
            value={form.college}
            onChange={e => setForm(s => ({ ...s, college: e.target.value, step_id: "" }))}
            className="rounded-xl border px-3 py-2.5 text-sm bg-white"
          >
            {colleges.map(c => <option key={c.id} value={c.id}>{c.name} only</option>)}
            <option value="all">Every college</option>
          </select>
          <select
            value={form.step_id}
            onChange={e => setForm(s => ({ ...s, step_id: e.target.value }))}
            disabled={form.college !== "GNIT"}
            className="rounded-xl border px-3 py-2.5 text-sm bg-white disabled:bg-gray-100 disabled:text-gray-400"
          >
            <option value="">Show at the end</option>
            {GNIT_STEPS.map(s => <option key={s.id} value={s.id}>Under step {s.label}</option>)}
          </select>
        </div>
        {form.college !== "GNIT" && (
          <p className="text-[11px] text-gray-400 mt-1.5">Only GNIT's steps are published yet, so {form.college === "all" ? "this" : form.college} file{form.college === "all" ? "s" : ""} will always show at the end.</p>
        )}

        <button
          onClick={upload}
          disabled={uploading || !file}
          className="mt-3 w-full rounded-xl bg-blue-600 text-white font-bold text-sm py-3 disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Upload to Route Map"}
        </button>
      </div>

      {/* ── Existing ───────────────────────────────────────────────────── */}
      {loading ? (
        <p className="px-6 text-sm text-gray-400">Loading…</p>
      ) : list.length === 0 ? (
        <div className="mx-4 rounded-2xl border border-dashed bg-white p-8 text-center">
          <p className="text-sm text-gray-500">Nothing uploaded yet.</p>
          <p className="text-xs text-gray-400 mt-1">Anything you add here appears in every student&apos;s Route Map straight away.</p>
        </div>
      ) : (
        grouped.map(g => (
          <div key={g.college} className="mx-4 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${COLLEGE_STYLE[g.college] ?? "bg-gray-100 text-gray-600"}`}>
                {g.college === "all" ? "BOTH COLLEGES" : g.college}
              </span>
              <span className="text-[11px] text-gray-400">{g.items.length} item{g.items.length > 1 ? "s" : ""}</span>
            </div>

            <div className="space-y-2">
              {g.items.map(a => (
                <div key={a.id} className="bg-white rounded-2xl border p-3 flex gap-3">
                  {a.kind === "image" ? (
                    <img src={a.file_url} alt={a.title} className="w-16 h-16 rounded-xl object-cover border flex-shrink-0 bg-gray-50" />
                  ) : (
                    <div className="w-16 h-16 rounded-xl border flex items-center justify-center bg-gray-50 flex-shrink-0"><FileText size={22} strokeWidth={1.8} className="text-gray-400" /></div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-gray-900 truncate">{a.title}</p>
                    {a.description && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{a.description}</p>}
                    <p className="text-[11px] text-gray-400 mt-1">
                      {a.step_id ? `Step ${a.step_id}` : "End of Route Map"}
                      {a.file_name ? ` · ${a.file_name}` : ""}
                    </p>
                  </div>
                  <button
                    onClick={() => remove(a)}
                    disabled={deleting === a.id}
                    className="self-start text-xs font-semibold text-red-600 px-2 py-1 disabled:opacity-40"
                  >
                    {deleting === a.id ? "…" : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
