"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Radio, CheckCircle2, Megaphone, School, FileText } from "lucide-react";

export default function BroadcastPage() {
  const router = useRouter();
  const [batches, setBatches] = useState<any[]>([]);
  const [batchId, setBatchId] = useState("");
  const [filter, setFilter] = useState<"all" | "approved" | "pending">("all");
  // Fetched, not a hardcoded all/GNIT/GNITC union — same trap as items
  // #101/#107/#114/#118, this time on the Step 1 college picker below.
  const [broadcastCollege, setBroadcastCollege] = useState<string>("all");
  const [colleges, setColleges] = useState<{ id: string; name: string }[]>([
    { id: "GNIT", name: "GNIT" }, { id: "GNITC", name: "GNITC" },
  ]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: number; total: number } | null>(null);
  const [preview, setPreview] = useState(false);
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  useEffect(() => {
    const role = localStorage.getItem("sp_role");
    if (!["admin", "super_admin"].includes(role ?? "")) { router.replace("/admin"); return; }
    fetch("/api/admin/batches", { headers: h() })
      .then(r => r.json())
      .then(j => setBatches(j.data ?? []));
    fetch("/api/settings/colleges").then(r => r.json()).then(j => {
      if (Array.isArray(j.data) && j.data.length) setColleges(j.data);
    }).catch(() => {});
  }, []);

  async function pickFile(f: File | null) {
    if (!f) { setFile(null); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/admin/announcements/upload", { method: "POST", headers: h(), body: fd });
      const j = await res.json();
      if (j.success) setFile({ url: j.data.url, name: j.data.name });
      else alert("Upload failed: " + (j.error ?? "unknown"));
    } catch { alert("Upload failed. Please try again."); }
    finally { setUploading(false); }
  }

  async function send() {
    if (!message.trim()) return;
    if (!confirm(
      `Send this message${file ? ` with "${file.name}"` : ""} to students (filter: ${filter})? This cannot be undone.`
    )) return;
    setSending(true); setResult(null);
    try {
      const res = await fetch("/api/admin/broadcast", {
        method: "POST",
        headers: { ...h(), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          batch_id: batchId || undefined,
          filter,
          attachment_url: file?.url,
          attachment_name: file?.name,
        }),
      });
      const j = await res.json();
      if (j.success) setResult(j.data);
      else alert("Error: " + (j.error ?? "Unknown error"));
    } finally { setSending(false); }
  }

  const charCount = message.length;
  const LIMIT = 4096;

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      <div className="bg-gradient-to-r from-pink-600 to-rose-600 text-white px-5 pt-10 pb-5">
        <button onClick={() => router.back()} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.15)", border:"1.5px solid rgba(255,255,255,0.25)", borderRadius:14, padding:"8px 16px 8px 10px", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", marginBottom:18, backdropFilter:"blur(4px)", WebkitBackdropFilter:"blur(4px)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <h1 className="text-xl font-bold flex items-center gap-2"><Radio size={18} strokeWidth={2} /> Broadcast</h1>
        <p className="text-sm opacity-75 mt-1">Send Telegram messages to selected students</p>
      </div>

      <div className="px-4 pt-5 space-y-4">

        {result && (
          <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4">
            <p className="font-bold text-emerald-700 flex items-center gap-1.5"><CheckCircle2 size={15} strokeWidth={2} /> Broadcast sent</p>
            <p className="text-emerald-600 text-sm mt-1">
              {result.sent} delivered · {result.failed} failed · {result.total} targeted
            </p>
            <button onClick={() => { setResult(null); setMessage(""); }}
              className="mt-3 text-xs text-emerald-700 font-semibold underline">
              Send another
            </button>
          </div>
        )}

        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Audience</p>

          {/* Step 1: College */}
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-2">Step 1 — Select college</label>
            <div className="flex gap-2 flex-wrap">
              {["all", ...colleges.map(c => c.id)].map(c => (
                <button key={c} type="button"
                  onClick={() => {
                    setBroadcastCollege(c);
                    setBatchId(""); // reset batch when college changes
                  }}
                  className={`flex-1 py-2.5 rounded-xl text-xs font-bold border transition-colors ${
                    broadcastCollege === c
                      ? c === "all" ? "bg-rose-600 text-white border-rose-600" : "bg-blue-600 text-white border-blue-600"
                      : "bg-gray-50 text-gray-600 border-gray-200"
                  }`}>
                  <span className="inline-flex items-center gap-1.5">{c === "all" ? <Megaphone size={12} strokeWidth={2} /> : <School size={12} strokeWidth={2} />} {c === "all" ? "All" : c}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: Batch */}
          {broadcastCollege !== "all" && (
            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-2">
                Step 2 — Select batch
              </label>
              <div className="flex flex-col gap-1.5">
                <button type="button"
                  onClick={() => setBatchId("")}
                  className={`w-full text-left px-4 py-3 rounded-xl text-sm font-semibold border transition-colors ${
                    batchId === ""
                      ? "bg-blue-50 border-blue-300 text-blue-700"
                      : "bg-gray-50 border-gray-200 text-gray-600"
                  }`}>
                  All {broadcastCollege} batches
                </button>
                {batches.filter(b => b.college === broadcastCollege).map(b => (
                  <button key={b.id} type="button"
                    onClick={() => setBatchId(b.id)}
                    className={`w-full text-left px-4 py-3 rounded-xl text-sm font-semibold border transition-colors ${
                      batchId === b.id
                        ? "bg-amber-50 border-amber-300 text-amber-700"
                        : "bg-gray-50 border-gray-200 text-gray-600"
                    }`}>
                    {b.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Filter by payment */}
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-2">Filter by payment</label>
            <div className="flex gap-2">
              {(["all", "approved", "pending"] as const).map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`flex-1 py-2.5 rounded-xl text-xs font-bold capitalize transition-colors
                    ${filter === f ? "bg-rose-600 text-white" : "bg-gray-100 text-gray-600"}`}>
                  {f}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Message</p>
          <p className="text-xs text-gray-400">Supports Telegram HTML: &lt;b&gt;bold&lt;/b&gt;, &lt;i&gt;italic&lt;/i&gt;, &lt;code&gt;code&lt;/code&gt;</p>
          <textarea value={message} onChange={e => setMessage(e.target.value)}
            rows={6} maxLength={LIMIT}
            placeholder="Type your message here&#8230;"
            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-rose-200" />
          <p className={`text-xs text-right ${charCount > LIMIT * 0.9 ? "text-rose-500" : "text-gray-400"}`}>
            {charCount} / {LIMIT}
          </p>

          {/* Attachment — photo or document, sent with the message */}
          <div className="border-t pt-3">
            <p className="text-xs font-semibold text-gray-600 mb-2">Attach a photo or document (optional)</p>
            {file ? (
              <div className="flex items-center gap-3 bg-gray-50 border rounded-xl p-3">
                {/\.(jpe?g|png|webp|gif)(\?|$)/i.test(file.url)
                  ? <img src={file.url} alt="" className="w-14 h-14 rounded-lg object-cover border" />
                  : <div className="w-14 h-14 rounded-lg border flex items-center justify-center bg-white"><FileText size={22} strokeWidth={1.6} className="text-gray-400" /></div>}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{file.name}</p>
                  <p className="text-[11px] text-gray-400">
                    {/\.(jpe?g|png|webp|gif)(\?|$)/i.test(file.url)
                      ? "Sent as a photo — students see it inline"
                      : "Sent as a file — students get a download button"}
                  </p>
                </div>
                <button onClick={() => setFile(null)} className="text-xs font-semibold text-rose-600 px-2">Remove</button>
              </div>
            ) : (
              <>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.doc,.docx"
                  disabled={uploading}
                  onChange={e => pickFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-rose-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-rose-700"
                />
                <p className="text-[11px] text-gray-400 mt-1.5">
                  {uploading ? "Uploading…" : "JPG, PNG, WEBP, PDF or DOCX · up to 10 MB"}
                </p>
              </>
            )}
            {file && charCount > 1024 && (
              <p className="text-[11px] text-amber-600 mt-2">
                Telegram captions stop at 1024 characters — the rest will arrive as a second message.
              </p>
            )}
          </div>
          {message.trim() && (
            <button onClick={() => setPreview(p => !p)} className="text-xs text-rose-600 font-semibold">
              {preview ? "Hide preview" : "Show preview"}
            </button>
          )}
          {preview && message.trim() && (
            <div className="bg-gray-50 rounded-xl p-3 border border-gray-200">
              <p className="text-xs text-gray-400 mb-2 font-semibold">Preview</p>
              <div className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed"
                dangerouslySetInnerHTML={{ __html: message.replace(/\n/g, "<br>") }} />
            </div>
          )}
        </div>

        <button onClick={send} disabled={sending || !message.trim()}
          className="w-full bg-gradient-to-r from-rose-600 to-pink-600 text-white font-bold py-4 rounded-2xl text-sm shadow-lg disabled:opacity-50 active:scale-[0.98] transition-transform">
          {sending ? "Sending…" : <span className="inline-flex items-center gap-1.5 justify-center"><Radio size={14} strokeWidth={2} /> Send Broadcast</span>}
        </button>

        <p className="text-xs text-gray-400 text-center pb-4">
          Only students who have started the bot will receive the message.
        </p>
      </div>
    </div>
  );
}
