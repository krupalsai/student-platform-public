"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, ChevronRight, Plus } from "lucide-react";

/**
 * Colleges — the drill-down step between Home and a college's batches.
 * Previously this was a row of pills sitting directly on the home screen
 * (item #169); live feedback asked for a real two-level flow instead: tap
 * into "Colleges" first, see the college list here, then tap one to reach
 * its batches. Nothing about /admin/batches-overview changed — this page
 * is just the new front door to it.
 *
 * The list comes from /api/admin/colleges, not /api/admin/stats: stats
 * only lists active colleges, so a college whose row is inactive but which
 * still has a running batch (BIET) never appeared anywhere an admin could
 * tap it, and a newly added college (no batches yet) was filtered out by
 * the old has_active_batch check. This list is complete — every active
 * college plus any college with an active batch.
 */
interface CollegeRow {
  id: string;
  name: string;
  students: number;
  batches: number;
  has_active_batch: boolean;
}

export default function AdminColleges() {
  const router = useRouter();
  const [colleges, setColleges] = useState<CollegeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/admin/colleges", { headers: h(), cache: "no-store" })
      .then(r => r.json())
      .then(j => {
        setColleges(j.success ? (j.data?.colleges ?? []) : []);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setNotice("");
    const cleanName = name.trim().replace(/\s+/g, " ");
    if (cleanName.length < 2) { setFormError("Enter the college name."); return; }
    const cleanCode = code.trim().toUpperCase();
    if (cleanCode && !/^[A-Z]{2,10}$/.test(cleanCode)) {
      setFormError("The short code should be 2–10 letters, like GNIT.");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/admin/colleges", {
        method: "POST",
        headers: { ...h(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanName, code: cleanCode || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) {
        setFormError(j.error ?? "Could not add the college. Please try again.");
        return;
      }
      setName("");
      setCode("");
      setShowForm(false);
      setNotice(
        j.data?.reactivated
          ? `${cleanName} is active again and shows below.`
          : `${cleanName} added — it shows below. Tap it to add its first batch.`,
      );
      load();
    } catch {
      setFormError("Could not add the college. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-8">
      <div className="bg-blue-600 text-white px-4 pt-10 pb-4">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <button
            onClick={() => router.back()}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.15)", border: "1.5px solid rgba(255,255,255,.25)", borderRadius: 14, padding: "8px 16px 8px 10px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            Back
          </button>
          <button
            onClick={() => { setShowForm(v => !v); setFormError(""); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.22)", border: "1.5px solid rgba(255,255,255,.4)", borderRadius: 14, padding: "8px 16px 8px 12px", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}
          >
            <Plus size={16} color="#fff" />
            Add college
          </button>
        </div>
        <h1 className="text-xl font-bold">Colleges</h1>
        <p className="text-sm opacity-80">Tap a college to see its batches</p>
      </div>

      <div className="px-4 mt-4 space-y-3">
        {showForm && (
          <form
            onSubmit={submit}
            style={{ background: "#fff", border: "1.5px solid #f0f0f0", borderRadius: 16, padding: "16px 18px", boxShadow: "0 2px 8px rgba(0,0,0,.04)" }}
          >
            <p style={{ fontSize: 15, fontWeight: 700, color: "#1D1D1F", margin: "0 0 12px" }}>Add a college</p>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#6E6E73", marginBottom: 4 }}>College name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Sreenidhi Institute of Science and Technology"
              maxLength={120}
              style={{ width: "100%", boxSizing: "border-box", border: "1.5px solid #e5e5ea", borderRadius: 12, padding: "10px 12px", fontSize: 14, marginBottom: 12 }}
            />
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#6E6E73", marginBottom: 4 }}>Short code (optional)</label>
            <input
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
              placeholder="e.g. SNIST"
              maxLength={10}
              style={{ width: "100%", boxSizing: "border-box", border: "1.5px solid #e5e5ea", borderRadius: 12, padding: "10px 12px", fontSize: 14 }}
            />
            <p style={{ fontSize: 12, color: "#8E8E93", margin: "6px 0 0" }}>Without a short code, one is made from the name. A college that already exists is re-activated instead of added twice.</p>
            {formError && <p style={{ fontSize: 13, color: "#FF3B30", fontWeight: 700, margin: "12px 0 0" }}>{formError}</p>}
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button
                type="submit"
                disabled={saving}
                style={{ flex: 1, background: "#007aff", color: "#fff", border: "none", borderRadius: 12, padding: "11px 16px", fontWeight: 800, fontSize: 14, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1 }}
              >
                {saving ? "Adding…" : "Add college"}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setFormError(""); }}
                style={{ background: "#F5F5F7", color: "#1D1D1F", border: "none", borderRadius: 12, padding: "11px 16px", fontWeight: 700, fontSize: 14, cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {notice && (
          <p style={{ background: "#dcfce7", color: "#166534", borderRadius: 12, padding: "10px 14px", fontSize: 13, fontWeight: 700, margin: 0 }}>{notice}</p>
        )}

        {loading ? (
          <>
            <div style={{ height: 78, borderRadius: 16, background: "rgba(0,0,0,.06)" }} />
            <div style={{ height: 78, borderRadius: 16, background: "rgba(0,0,0,.06)" }} />
          </>
        ) : colleges.length === 0 ? (
          <p className="text-center text-gray-400 py-8 text-sm">No colleges yet. Add the first college above.</p>
        ) : (
          colleges.map(c => (
            <button
              key={c.id}
              onClick={() => router.push(`/admin/batches-overview?college=${c.id}`)}
              style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left", background: "#fff", border: "1.5px solid #f0f0f0", borderRadius: 16, padding: "16px 18px", cursor: "pointer", boxShadow: "0 2px 8px rgba(0,0,0,.04)" }}
            >
              <span style={{ width: 44, height: 44, borderRadius: 12, background: "#e8f1ff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Building2 size={20} color="#007aff" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 15, fontWeight: 700, color: "#111827", margin: 0 }}>{c.name}</p>
                <p style={{ fontSize: 12, color: "#9ca3af", margin: "3px 0 0" }}>
                  {c.batches} {c.batches === 1 ? "batch" : "batches"} · {c.students} students
                </p>
              </div>
              <ChevronRight size={18} color="#007aff" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}
