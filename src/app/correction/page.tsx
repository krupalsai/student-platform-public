"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { CheckCircle2, Lock, AlertTriangle, Star, UploadCloud } from "lucide-react";
import { ALLOWED_IMAGE_MIME, ACCEPT_ATTR } from "@/lib/image-types";
import { ui } from "@/lib/student-ui";

const ALLOWED_TYPES = ALLOWED_IMAGE_MIME as readonly string[];

export default function CorrectionPage() {
  const router = useRouter();

  const [profile, setProfile]   = useState<any>(null);
  const [loading, setLoading]   = useState(true);
  const [saving,  setSaving]    = useState(false);
  const [done,    setDone]      = useState(false);
  const [error,   setError]     = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Editable fields
  const [fullName,     setFullName]     = useState("");
  const [fatherName,   setFatherName]   = useState("");
  const [phone,        setPhone]        = useState("");
  const [homeAddress,  setHomeAddress]  = useState("");

  // ID card upload
  const [idFile,    setIdFile]    = useState<File | null>(null);
  const [idPreview, setIdPreview] = useState("");
  const [idPath,    setIdPath]    = useState("");
  const [idError,   setIdError]   = useState("");

  const authH = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  useEffect(() => {
    const t = localStorage.getItem("sp_token");
    if (!t) { router.replace("/"); return; }
    fetch("/api/profile", { headers: authH() })
      .then(r => r.json())
      .then(j => {
        if (!j.success || !j.data?.is_profile_complete) { router.replace("/register"); return; }
        const p = j.data;
        setProfile(p);
        setFullName(p.full_name ?? "");
        setFatherName(p.father_name ?? "");
        setPhone(p.phone ?? "");
        setHomeAddress(p.home_address ?? "");
        setLoading(false);
      })
      .catch(() => router.replace("/"));
  }, []);

  function pickId(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!ALLOWED_TYPES.includes(f.type)) { setIdError("Only JPG, PNG, or WEBP allowed"); e.target.value = ""; return; }
    if (f.size > 5 * 1024 * 1024) { setIdError("File too large. Max 5 MB"); e.target.value = ""; return; }
    setIdError(""); setIdFile(f); setIdPath(""); setIdPreview(URL.createObjectURL(f));
  }

  async function uploadId(): Promise<string | null> {
    if (idPath) return idPath;
    if (!idFile) return null;
    const fd = new FormData();
    fd.append("file", idFile);
    const r = await fetch("/api/uploads/college-id", {
      method: "POST",
      headers: authH(),
      body: fd,
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.error ?? "Upload failed");
    setIdPath(j.data.storage_path);
    return j.data.storage_path;
  }

  async function handleSave() {
    setError(""); setFieldErrors({});
    const errs: Record<string, string> = {};
    if (!fullName.trim())    errs.full_name    = "Required";
    if (!fatherName.trim())  errs.father_name  = "Required";
    if (!phone.trim())       errs.phone        = "Required";
    else if (!/^[6-9]\d{9}$/.test(phone.trim())) errs.phone = "Enter a valid 10-digit number";
    if (!homeAddress.trim()) errs.home_address = "Required";
    else if (homeAddress.trim().length < 10) errs.home_address = "Please enter your full address";
    if (Object.keys(errs).length) { setFieldErrors(errs); return; }

    setSaving(true);
    try {
      const college_id_path = await uploadId();
      const payload: Record<string, string> = {
        full_name:    fullName.trim(),
        father_name:  fatherName.trim(),
        phone:        phone.trim(),
        home_address: homeAddress.trim(),
      };
      if (college_id_path) payload.college_id_path = college_id_path;

      const r = await fetch("/api/profile/correction", {
        method: "POST",
        headers: { ...authH(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.success) { setError(j.error ?? "Could not save. Please try again."); return; }
      setDone(true);
    } catch (e: any) {
      setError(e.message ?? "Something went wrong.");
    } finally {
      setSaving(false);
    }
  }

  const inp = "w-full bg-white rounded-xl px-4 py-3 text-sm focus:outline-none transition-shadow";
  const inpStyle = { border: `1px solid ${ui.borderStrong}` };

  /* ── Batch closed — the window is closed too, don't show a form that will
       only reject on submit (see api/profile/correction/route.ts). ────────── */
  if (!loading && profile?.batches?.status === "closed") {
    return (
      <div className="min-h-screen pb-10" style={{ background: ui.canvas }}>
        <PageHeader title="Correction Window" subtitle="Fix your details or re-upload your ID" backHref="/dashboard" />
        <div className="max-w-lg mx-auto px-4 mt-5">
          <div className="rounded-2xl p-6 text-center" style={{ background: ui.surface, border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card }}>
            <Lock size={26} strokeWidth={1.6} className="mx-auto mb-3" style={{ color: ui.textTertiary }} />
            <h2 className="text-lg font-semibold" style={{ color: ui.textPrimary }}>Correction Window Closed</h2>
            <p className="text-sm mt-2 leading-relaxed" style={{ color: ui.textSecondary }}>
              Your batch has been closed, so corrections are no longer possible here. Contact your admin for any further changes.
            </p>
            <button onClick={() => router.replace("/dashboard")}
              className="mt-6 text-white font-medium px-8 py-3 rounded-xl active:scale-95 transition-transform"
              style={{ background: ui.accent }}>
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── Success state ─────────────────────────────────────────────────────── */
  if (done) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center" style={{ background: ui.canvas }}>
        <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5" style={{ background: ui.successSoft }}><CheckCircle2 size={30} strokeWidth={1.6} style={{ color: ui.success }} /></div>
        <h2 className="text-xl font-semibold" style={{ color: ui.textPrimary }}>Correction Saved</h2>
        <p className="text-sm mt-2 leading-relaxed max-w-xs" style={{ color: ui.textSecondary }}>
          Your updated details have been saved. The admin will see the latest College ID card in their review queue.
        </p>
        <button onClick={() => router.replace("/dashboard")}
          className="mt-8 text-white font-medium px-10 py-3.5 rounded-xl active:scale-95 transition-transform"
          style={{ background: ui.accent }}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  return (
    <main className="min-h-screen pb-10" style={{ background: ui.canvas }}>
      <PageHeader
        title="Correction Window"
        subtitle="Fix your details or re-upload your ID"
        backHref="/dashboard"
      />

      <div className="max-w-lg mx-auto px-4 mt-5 space-y-3">

        {/* AI-detected problem — shown only when Gemini actually flagged
             something on the last uploaded College ID (src/lib/id-ocr.ts).
             Surfaces the model's own note so the student knows exactly
             what to fix, instead of only the generic instructions below. */}
        {!loading && profile?.college_id_ai_flag?.isIdCard === true && profile.college_id_ai_flag.hasSignature === false && (
          <div className="rounded-2xl p-4 flex items-start gap-3" style={{ background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}` }}>
            <AlertTriangle size={16} strokeWidth={1.8} className="mt-0.5 shrink-0" style={{ color: ui.danger }} />
            <div>
              <p className="text-sm font-semibold" style={{ color: ui.danger }}>We couldn't detect your signature</p>
              <p className="text-xs mt-0.5 leading-relaxed" style={{ color: ui.danger, opacity: 0.85 }}>
                {profile.college_id_ai_flag.notes || "Our automatic check on your uploaded College ID didn't find your signature."} Please re-upload below.
              </p>
            </div>
          </div>
        )}

        {/* Info banner */}
        <div className="rounded-2xl p-4 flex items-start gap-3" style={{ background: ui.warningSoft, border: `1px solid ${ui.warningSoftBorder}` }}>
          <Lock size={16} strokeWidth={1.8} className="mt-0.5 shrink-0" style={{ color: ui.warning }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: ui.warning }}>Last chance to correct mistakes</p>
            <p className="text-xs mt-0.5 leading-relaxed" style={{ color: ui.warning }}>
              You can fix your name, phone, address, and re-upload your College ID card here.
              Roll number, branch, and year cannot be changed — contact your admin for those.
            </p>
            <p className="text-xs font-medium mt-1.5" style={{ color: ui.warning }}>
              This window closes 7 days after your payment is approved, or immediately if your batch is closed.
            </p>
          </div>
        </div>

        {error && (
          <div className="text-sm p-3.5 rounded-xl" style={{ background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, color: ui.danger }}>{error}</div>
        )}

        {/* Locked fields (read-only display) */}
        {!loading && profile && (
          <div className="rounded-2xl p-4 space-y-2" style={{ background: ui.surface, border: `1px solid ${ui.border}` }}>
            <p className="text-xs font-medium uppercase tracking-wider mb-2 flex items-center gap-1.5" style={{ color: ui.textTertiary }}><Lock size={11} strokeWidth={1.8} /> Cannot be changed</p>
            {[
              { label: "Roll Number", value: profile.roll_number },
              { label: "Branch",      value: profile.branch },
              { label: "Year",        value: profile.year },
              { label: "College",     value: profile.college },
            ].map(f => (
              <div key={f.label} className="flex items-center justify-between">
                <span className="text-xs font-medium" style={{ color: ui.textTertiary }}>{f.label}</span>
                <span className="text-xs font-semibold" style={{ color: ui.textSecondary }}>{f.value ?? "—"}</span>
              </div>
            ))}
          </div>
        )}

        {loading ? (
          <div className="space-y-3">
            {[1,2,3,4].map(i => <div key={i} className="h-14 rounded-xl animate-pulse" style={{ background: ui.surface }} />)}
          </div>
        ) : (
          <>
            {/* Editable fields */}
            {[
              { label: "Full Name",    value: fullName,    set: setFullName,    key: "full_name",    ph: "As per college records", type: "text" },
              { label: "Father Name",  value: fatherName,  set: setFatherName,  key: "father_name",  ph: "Father's full name",     type: "text" },
              { label: "Phone Number", value: phone,       set: setPhone,       key: "phone",        ph: "10-digit mobile number", type: "tel"  },
            ].map(f => (
              <div key={f.key}>
                <label className="text-sm font-medium block mb-1.5" style={{ color: ui.textPrimary }}>{f.label}</label>
                <input type={f.type} className={inp} style={inpStyle} placeholder={f.ph} value={f.value}
                  onChange={e => f.set(e.target.value)} />
                {fieldErrors[f.key] && <p className="text-xs mt-1" style={{ color: ui.danger }}>{fieldErrors[f.key]}</p>}
              </div>
            ))}

            <div>
              <label className="text-sm font-medium block mb-1.5" style={{ color: ui.textPrimary }}>Home Address</label>
              <textarea className="w-full bg-white rounded-xl px-4 py-3 text-sm focus:outline-none resize-none"
                style={{ border: `1px solid ${ui.borderStrong}` }}
                rows={3} placeholder="Door no., Street, City, District, State — PIN code"
                value={homeAddress} onChange={e => setHomeAddress(e.target.value)} />
              {fieldErrors.home_address && <p className="text-xs mt-1" style={{ color: ui.danger }}>{fieldErrors.home_address}</p>}
            </div>

            {/* College ID re-upload */}
            <div>
              <label className="text-sm font-medium block mb-1.5" style={{ color: ui.textPrimary }}>
                College ID Card — Re-upload
              </label>

              {/* Reminder instruction */}
              <div className="mb-3 rounded-2xl p-3.5" style={{ background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}` }}>
                <p className="text-xs font-semibold mb-1.5 flex items-center gap-1.5" style={{ color: ui.danger }}>
                  <Star size={12} strokeWidth={2} /> Remember to sign before uploading
                </p>
                <ol className="space-y-1">
                  {[
                    "Place your College ID flat on a plain surface",
                    "Sign your name clearly next to the ID card",
                    "Photo must show all four corners — no blur or glare",
                    "Upload your own ID with all details fully visible — do not blur or mask anything",
                  ].map((s, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: ui.dangerSoftBorder, color: ui.danger }}>{i+1}</span>
                      <span className="text-xs leading-relaxed" style={{ color: ui.danger }}>{s}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <input type="file" accept={ACCEPT_ATTR}
                onChange={pickId} className="hidden" id="cid-upload" />
              <label htmlFor="cid-upload"
                className="flex items-center justify-center gap-3 w-full border rounded-2xl py-5 text-sm cursor-pointer transition-colors"
                style={idError
                  ? { borderColor: ui.dangerSoftBorder, background: ui.dangerSoft, color: ui.danger, borderStyle: "dashed" }
                  : idPreview
                  ? { borderColor: ui.accentSoftBorder, background: ui.accentSoft, color: ui.accent, borderStyle: "dashed" }
                  : { borderColor: ui.borderStrong, color: ui.textTertiary, borderStyle: "dashed" }}>
                <UploadCloud size={18} strokeWidth={1.8} />
                {idPreview ? "New ID selected — tap to change" : "Tap to upload corrected College ID"}
              </label>
              <p className="text-xs mt-1" style={{ color: ui.textTertiary }}>JPG, PNG, WEBP · Max 5 MB · Optional if ID is already correct</p>
              {idPreview && <img src={idPreview} className="mt-2 w-full rounded-2xl max-h-48 object-cover" alt="College ID preview" />}
              {idError && <p className="text-xs mt-1" style={{ color: ui.danger }}>{idError}</p>}
            </div>

            <button onClick={handleSave} disabled={saving}
              className="w-full text-white py-4 rounded-xl font-medium disabled:opacity-60 text-base active:scale-[0.98] transition-transform"
              style={{ background: ui.textPrimary }}>
              {saving
                ? <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                    Saving…
                  </span>
                : "Save Corrections"
              }
            </button>
          </>
        )}
      </div>
    </main>
  );
}
