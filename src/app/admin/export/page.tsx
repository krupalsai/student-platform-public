"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, FolderArchive, Check, ClipboardList } from "lucide-react";

interface College { id: string; name: string; }
interface Batch {
  id: string; name: string; college: string | null;
  status: string; batch_limit: number | null;
  // The batches API returns student_count (finished registrations) and
  // member_count (every profile with a batch_id). It never returns
  // `enrolled` — the page read b.enrolled and showed "?" for every batch.
  student_count?: number; member_count?: number;
}

const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  active:   { bg: "bg-green-100",  text: "text-green-700",  label: "Active"   },
  full:     { bg: "bg-red-100",    text: "text-red-700",    label: "Full"     },
  paused:   { bg: "bg-amber-100",  text: "text-amber-700",  label: "Paused"   },
  closed:   { bg: "bg-gray-100",   text: "text-gray-600",   label: "Closed"   },
  archived: { bg: "bg-gray-100",   text: "text-gray-400",   label: "Archived" },
};

export default function ExportPage() {
  const router = useRouter();
  const [colleges,    setColleges]    = useState<College[]>([]);
  const [batches,     setBatches]     = useState<Batch[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [college,     setCollege]     = useState("");
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [downloading, setDownloading] = useState<"docx" | "zip" | null>(null);
  const [toast,       setToast]       = useState<{ msg: string; ok: boolean } | null>(null);

  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  function showToast(msg: string, ok: boolean = true) { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); }

  // Load colleges dynamically
  useEffect(() => {
    fetch("/api/settings/colleges", { headers: h() })
      .then(r => r.json())
      .then(j => {
        const list: College[] = j.data ?? [];
        setColleges(list);
        if (list.length > 0) setCollege(list[0].id);
      })
      .catch(() => {
        // fallback
        setColleges([{ id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" }]);
        setCollege("GNIT");
      });
  }, []);

  // Load all batches (all statuses for export)
  useEffect(() => {
    fetch("/api/admin/batches?all=1", { headers: h() })
      .then(r => r.json())
      .then(j => { setBatches(j.data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Reset batch selection when college tab switches
  function switchCollege(c: string) { setCollege(c); setSelectedId(null); }

  const list = batches
    .filter(b => (b.college ?? "").toUpperCase() === college.toUpperCase())
    .sort((a, b) => {
      // Active first, then by name
      if (a.status === "active" && b.status !== "active") return -1;
      if (b.status === "active" && a.status !== "active") return 1;
      return a.name.localeCompare(b.name);
    });
  // Archived draft batches are not export targets — they cluttered the list
  // (four 2026-07/08 drafts above the real batches). Keep them out of the
  // main list and behind a collapsed section so they stay reachable but
  // never in the way. (Admin request, 11 Nov 2026: "How unorganised".)
  const mainList = list.filter(b => b.status !== "archived");
  const archivedList = list.filter(b => b.status === "archived");
  const selected = [...mainList, ...archivedList].find(b => b.id === selectedId) ?? null;

  async function download(type: "docx" | "zip") {
    if (!selected || downloading) return;
    setDownloading(type);
    try {
      const token = localStorage.getItem("sp_token") ?? "";
      const suffix = type === "docx"
        ? `/api/admin/export/docx/${selected.id}?token=${encodeURIComponent(token)}`
        : `/api/admin/export/docx/${selected.id}/zip?token=${encodeURIComponent(token)}`;


      const res = await fetch(
        type === "docx"
          ? `/api/admin/export/docx/${selected.id}`
          : `/api/admin/export/docx/${selected.id}/zip`,
        { headers: h() }
      );
      if (!res.ok) { showToast("Export failed. Please try again.", false); return; }
      const blob = await res.blob();
      const a    = document.createElement("a");
      a.href     = URL.createObjectURL(blob);
      a.download = type === "docx"
        ? `${selected.name.replace(/[^a-zA-Z0-9_-]+/g, "_")}_petition_list.docx`
        : `${selected.name.replace(/[^a-zA-Z0-9_-]+/g, "_")}_documents.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      showToast("Download started");
    } finally { setDownloading(null); }
  }

  const inp = "bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200";

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      <div className="bg-blue-600 text-white px-4 pt-10 pb-5">
        <button onClick={() => router.back()}
          className="inline-flex items-center gap-2 bg-white/15 border border-white/25 rounded-xl px-4 py-2 text-sm font-bold mb-4">
          ← Back
        </button>
        <h1 className="text-xl font-bold">Export / Petition List</h1>
        <p className="text-sm text-white/70 mt-0.5">Download DOCX or ZIP per batch</p>
      </div>

      {toast && (
        <div className={`mx-4 mt-3 text-sm p-3 rounded-xl text-center font-medium ${toast.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
          {toast.msg}
        </div>
      )}

      <div className="px-4 mt-5 space-y-4">

        {/* College tabs — dynamic */}
        <div className="flex gap-2 overflow-x-auto">
          {colleges.map(c => (
            <button key={c.id} onClick={() => switchCollege(c.id)}
              className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
                college === c.id ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600"
              }`}>
              {c.name}
            </button>
          ))}
        </div>

        {/* Batch list — live batches only; archived drafts live behind the
            collapsed section below so the export list stays clean. */}
        {loading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => <div key={i} className="h-20 bg-white rounded-2xl animate-pulse" />)}
          </div>
        ) : mainList.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <ClipboardList size={30} strokeWidth={1.6} className="mx-auto mb-3 text-gray-300" />
            <p className="font-semibold">No batches for {college}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {mainList.map(b => {
              const badge = STATUS_BADGE[b.status] ?? STATUS_BADGE.closed;
              // student_count = finished registrations (the exportable
              // members); member_count = every profile incl. abandoned
              // attempts. Never "?" — the API always returns both.
              const members = b.student_count ?? b.member_count ?? 0;
              const capacity = b.batch_limit
                ? `${members} / ${b.batch_limit} members`
                : `${members} members · Unlimited`;
              const isSelected = selectedId === b.id;

              return (
                <button key={b.id} onClick={() => setSelectedId(isSelected ? null : b.id)}
                  className={`w-full text-left rounded-2xl p-4 border-2 transition-all ${
                    isSelected
                      ? "bg-blue-50 border-blue-300 shadow-sm"
                      : "bg-white border-gray-100 hover:border-gray-200"
                  }`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-bold text-sm text-gray-800">{b.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{capacity}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${badge.bg} ${badge.text}`}>
                        {badge.label}
                      </span>
                      {isSelected && <Check size={16} strokeWidth={2.5} className="text-blue-600" />}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Archived drafts — collapsed, out of the way but still exportable. */}
        {!loading && archivedList.length > 0 && (
          <div>
            <button onClick={() => setShowArchived(v => !v)}
              className="w-full text-left text-sm font-semibold text-gray-500 bg-white border border-gray-200 rounded-2xl px-4 py-3">
              {showArchived ? "▾" : "▸"} Archived batches ({archivedList.length})
            </button>
            {showArchived && (
              <div className="space-y-2 mt-2">
                {archivedList.map(b => {
                  const badge = STATUS_BADGE.archived;
                  const members = b.student_count ?? b.member_count ?? 0;
                  const capacity = b.batch_limit
                    ? `${members} / ${b.batch_limit} members`
                    : `${members} members · Unlimited`;
                  const isSelected = selectedId === b.id;
                  return (
                    <button key={b.id} onClick={() => setSelectedId(isSelected ? null : b.id)}
                      className={`w-full text-left rounded-2xl p-4 border-2 transition-all ${
                        isSelected
                          ? "bg-blue-50 border-blue-300 shadow-sm"
                          : "bg-white border-gray-100 hover:border-gray-200"
                      }`}>
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-bold text-sm text-gray-800">{b.name}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{capacity}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${badge.bg} ${badge.text}`}>
                            {badge.label}
                          </span>
                          {isSelected && <Check size={16} strokeWidth={2.5} className="text-blue-600" />}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Download actions — shown when a batch is selected */}
        {selected && (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-3">
            <p className="text-sm font-bold text-gray-800">
              Download: <span className="text-blue-600">{selected.name}</span>
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => download("docx")} disabled={!!downloading}
                className="flex flex-col items-center gap-2 bg-blue-50 border border-blue-100 rounded-2xl py-4 text-sm font-semibold text-blue-700 disabled:opacity-50 active:scale-[0.97] transition-transform">
                <FileText size={22} strokeWidth={1.8} />
                {downloading === "docx" ? "Generating…" : "Petition DOCX"}
              </button>
              <button onClick={() => download("zip")} disabled={!!downloading}
                className="flex flex-col items-center gap-2 bg-purple-50 border border-purple-100 rounded-2xl py-4 text-sm font-semibold text-purple-700 disabled:opacity-50 active:scale-[0.97] transition-transform">
                <FolderArchive size={22} strokeWidth={1.8} />
                {downloading === "zip" ? "Packing…" : "DOCX + ZIP"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
