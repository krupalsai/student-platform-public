"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  GraduationCap, User, Phone, School, Hash, BookOpen, CalendarDays, Home,
  Check, LogOut, X, AlertTriangle, CheckCircle2, type LucideIcon,
} from "lucide-react";
import StudentBottomNav from "@/components/student/StudentBottomNav";
import SoundSettingsCard from "@/components/student/SoundSettingsCard";
import { ACCEPT_ATTR, IMAGE_TYPE_ERROR, isAllowedImage } from "@/lib/image-types";
import { ui } from "@/lib/student-ui";
import { PAY_STATUS } from "@/lib/hooks/useStudentData";

function Row({ Icon, label, value }: { Icon: LucideIcon; label: string; value: string }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 16px",
      borderBottom: `1px solid ${ui.divider}` }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, background: ui.accent,
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0 }}><Icon size={16} strokeWidth={2} color="#fff" /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 11, color: ui.textTertiary, fontWeight: 500, margin: 0 }}>{label}</p>
        <p style={{ fontSize: 14, color: ui.textPrimary, fontWeight: 500, margin: "2px 0 0",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</p>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<any>(null);
  const [payment, setPayment] = useState<any>(null);
  const [extraFeeDue, setExtraFeeDue] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reuploadOpen, setReuploadOpen] = useState(false);
  const [reuploadFile, setReuploadFile] = useState<File | null>(null);
  const [reuploadPreview, setReuploadPreview] = useState("");
  const [reuploadBusy, setReuploadBusy] = useState(false);
  const [reuploadError, setReuploadError] = useState("");
  const [reuploadDone, setReuploadDone] = useState(false);
  const [reuploadPath, setReuploadPath] = useState("");
  const [reuploadChecking, setReuploadChecking] = useState(false);
  const [reuploadAiCheck, setReuploadAiCheck] = useState<{ isIdCard: boolean; hasSignature: boolean; notes: string | null } | null>(null);
  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  useEffect(() => {
    const t = localStorage.getItem("sp_token");
    if (!t) { router.replace("/"); return; }
    Promise.all([
      fetch("/api/profile",         { headers: h() }).then(r => r.json()),
      fetch("/api/payments/status", { headers: h() }).then(r => r.json()),
      fetch("/api/extra-fee",       { headers: h() }).then(r => r.json()).catch(() => null),
    ]).then(([p, pay, extra]) => {
      if (!p.success) { router.replace("/"); return; }
      setProfile(p.data);
      setPayment(pay.data ?? null);
      setExtraFeeDue(!!extra?.data?.due);
      setLoading(false);
    }).catch(() => router.replace("/"));
  }, []);

  const payStatus = payment?.status ?? "pending";
  const ps = PAY_STATUS[payStatus] ?? PAY_STATUS.pending;
  const initial = (profile?.full_name ?? "S").charAt(0).toUpperCase();

  async function signOut() { await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` } }).catch(() => {}); localStorage.clear(); sessionStorage.clear(); router.replace("/login"); }

  async function pickReuploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!isAllowedImage(f.type)) { setReuploadError(IMAGE_TYPE_ERROR); return; }
    if (f.size > 5*1024*1024) { setReuploadError("File too large. Max 5 MB"); return; }
    setReuploadError(""); setReuploadFile(f);
    setReuploadPreview(URL.createObjectURL(f));
    setReuploadPath(""); setReuploadAiCheck(null);

    // Upload + AI-check right away, same as registration's College ID
    // upload — the student needs to see the warning before they can even
    // tick the confirm box, not discover it only after submitting.
    setReuploadChecking(true);
    try {
      const token = localStorage.getItem("sp_token") ?? "";
      const fd = new FormData(); fd.append("file", f);
      const uploadRes = await fetch("/api/uploads/college-id", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
      const uploadJson = await uploadRes.json();
      if (!uploadJson.success) { setReuploadError(uploadJson.error ?? "Upload failed"); return; }
      setReuploadPath(uploadJson.data.storage_path);
      setReuploadAiCheck(uploadJson.data.ai_check ?? null);
    } catch {
      setReuploadError("Upload failed — check your connection and try again");
    } finally {
      setReuploadChecking(false);
    }
  }

  // Same hard-block rule as registration (item #62): blocks ONLY when the
  // AI actually flagged a real problem. A null aiCheck (the vision call
  // itself couldn't run — both Gemini and Groq unavailable, TODO #19)
  // does NOT block — see the collegeIdPath && !aiCheck notice in
  // register/page.tsx's comment for the reasoning (same page, mirrored
  // here): don't block registration on an infrastructure gap, just nudge
  // the student toward the reference example before they submit.
  const reuploadBlocked = !!(reuploadAiCheck && (!reuploadAiCheck.isIdCard || !reuploadAiCheck.hasSignature));

  async function submitReupload() {
    if (!reuploadFile) { setReuploadError("Please select a photo first"); return; }
    if (reuploadChecking) { setReuploadError("Still analyzing your photo — one moment"); return; }
    if (reuploadBlocked) {
      setReuploadError("Please upload a photo that clearly shows your ID and signature.");
      return;
    }
    if (!reuploadPath) { setReuploadError("Please select a photo first"); return; }
    setReuploadBusy(true); setReuploadError("");
    try {
      const token = localStorage.getItem("sp_token") ?? "";
      const saveRes = await fetch("/api/profile/reupload-id", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ storage_path: reuploadPath }),
      });
      const saveJson = await saveRes.json();
      if (!saveJson.success) throw new Error(saveJson.error ?? "Could not save");

      setReuploadDone(true);
      setReuploadOpen(false);
      setProfile((p: any) => p ? { ...p, college_id_reupload_used: true } : p);
    } catch (e: any) {
      setReuploadError(e?.message ?? "Something went wrong. Please try again.");
    } finally {
      setReuploadBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", background: ui.canvas, paddingBottom: 108 }}>

      {/* Top bar: back arrow + centred title */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: ui.surface, borderBottom: `1px solid ${ui.border}`,
        display: "flex", alignItems: "center", padding: "14px 12px" }}>
        <button onClick={() => router.back()} aria-label="Back"
          style={{ width: 36, height: 36, borderRadius: 999, background: "none", border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={ui.accent}
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        </button>
        <h1 style={{ flex: 1, textAlign: "center", fontSize: 18, fontWeight: 700, color: ui.textPrimary, margin: "0 36px 0 0" }}>Profile</h1>
      </div>

      {/* Avatar card */}
      <div style={{ padding: "16px 16px 0" }}>
        <div style={{ background: ui.surface, borderRadius: ui.radius.card, boxShadow: ui.shadow.card, padding: "18px 16px",
          display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 60, height: 60, borderRadius: 999, flexShrink: 0, background: "linear-gradient(180deg,#a1a1aa,#7c7c85)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontSize: 24, fontWeight: 700 }}>
            {loading ? "…" : initial}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {loading
              ? <>
                  <div style={{ height: 18, width: 140, background: ui.canvas, borderRadius: 8, marginBottom: 8 }} />
                  <div style={{ height: 12, width: 100, background: ui.canvas, borderRadius: 6 }} />
                </>
              : <>
                  <p style={{ color: ui.textPrimary, fontSize: 19, fontWeight: 700, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {profile?.full_name ?? "Student"}
                  </p>
                  <p style={{ color: ui.textSecondary, fontSize: 12.5, margin: "3px 0 0" }}>
                    {[profile?.college, profile?.branch, profile?.year ? `Year ${profile.year}` : null].filter(Boolean).join(" · ")}
                  </p>
                  <span style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 7,
                    background: ps.bg, border: `1px solid ${ps.border}`, borderRadius: ui.radius.pill, padding: "4px 12px" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: ps.dot, flexShrink: 0 }} />
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: ps.text }}>Fee: {ps.label}</span>
                  </span>
                </>
            }
          </div>
        </div>
      </div>

      <div style={{ padding: "16px 16px 0", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Incomplete profile banner */}
        {!loading && !profile?.is_profile_complete && (
          <button onClick={() => router.push("/register")}
            style={{ width: "100%", background: ui.surface, border: `1px solid ${ui.border}`,
              borderRadius: ui.radius.card, padding: "14px 16px", display: "flex", alignItems: "center",
              justifyContent: "space-between", cursor: "pointer", boxShadow: ui.shadow.card }}>
            <div style={{ textAlign: "left" }}>
              <p style={{ color: ui.textPrimary, fontWeight: 600, fontSize: 13, margin: 0 }}>Profile incomplete</p>
              <p style={{ color: ui.textSecondary, fontSize: 11, margin: "3px 0 0" }}>Tap to fill in your details</p>
            </div>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ui.textTertiary}
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        )}

        {/* Student details card */}
        <div style={{ background: ui.surface, borderRadius: ui.radius.card, overflow: "hidden",
          border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: ui.textTertiary, textTransform: "uppercase",
            letterSpacing: 1, padding: "14px 16px 8px", margin: 0 }}>Student Details</p>
          {loading
            ? [1,2,3,4,5,6,7,8].map(i => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 14,
                  padding: "13px 16px", borderBottom: `1px solid ${ui.divider}` }}>
                  <div style={{ width: 36, height: 36, borderRadius: ui.radius.tile, background: ui.canvas, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ height: 10, width: "30%", background: ui.canvas, borderRadius: 4, marginBottom: 6 }} />
                    <div style={{ height: 14, width: "60%", background: ui.canvas, borderRadius: 4 }} />
                  </div>
                </div>
              ))
            : <>
                <Row Icon={GraduationCap} label="Full Name"    value={profile?.full_name} />
                <Row Icon={User}          label="Father Name"  value={profile?.father_name} />
                <Row Icon={Phone}         label="Phone"        value={profile?.phone} />
                <Row Icon={School}        label="College"      value={profile?.college} />
                <Row Icon={Hash}          label="Roll Number"  value={profile?.roll_number} />
                <Row Icon={BookOpen}      label="Branch"       value={profile?.branch} />
                <Row Icon={CalendarDays}  label="Year"         value={profile?.year ? `Year ${profile.year}` : ""} />
                <Row Icon={Home}          label="Home Address" value={profile?.home_address} />
              </>
          }
        </div>

        {/* College ID — status + one-time re-upload */}
        {!loading && profile?.college_id_path && (
          <div style={{ background: ui.surface, borderRadius: ui.radius.card, padding: 16,
            border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card }}>
            <p style={{ fontSize: 11, fontWeight: 600, color: ui.textTertiary, textTransform: "uppercase",
              letterSpacing: 1, margin: "0 0 10px" }}>College ID</p>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 36, height: 36, borderRadius: ui.radius.tile, background: ui.canvas,
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={ui.success} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              </span>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>Uploaded</p>
                <p style={{ fontSize: 11, color: ui.textTertiary, margin: "2px 0 0" }}>
                  {profile?.college_id_reupload_used ? "Re-upload already used" : "You can re-upload this once, if needed"}
                </p>
              </div>
              {!profile?.college_id_reupload_used && !reuploadDone && (
                <button onClick={() => setReuploadOpen(true)}
                  style={{ background: ui.accent, color: "#fff", border: "none", borderRadius: ui.radius.button,
                    padding: "8px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer", flexShrink: 0 }}>
                  Re-upload
                </button>
              )}
            </div>
            {reuploadDone && (
              <p style={{ fontSize: 12, color: ui.success, fontWeight: 500, margin: "10px 0 0", display: "flex", alignItems: "center", gap: 5 }}>
                <Check size={12} strokeWidth={2} /> Re-uploaded successfully.
              </p>
            )}
          </div>
        )}

        {/* In-app sounds: on/off + a test */}
        {!loading && <SoundSettingsCard />}

        {/* Sign out */}
        <button onClick={signOut}
          style={{ width: "100%", background: ui.surface, border: `1px solid ${ui.border}`, borderRadius: ui.radius.card,
            padding: "14px 16px", display: "flex", alignItems: "center", gap: 14,
            cursor: "pointer", boxShadow: ui.shadow.card }}>
          <span style={{ width: 36, height: 36, borderRadius: ui.radius.tile, background: ui.canvas,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><LogOut size={16} strokeWidth={1.8} color={ui.danger} /></span>
          <span style={{ fontSize: 14, fontWeight: 500, color: ui.danger }}>Sign Out</span>
        </button>
      </div>

      {/* Re-upload modal */}
      {reuploadOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50,
          display: "flex", alignItems: "flex-end", backdropFilter: "blur(4px)" }}>
          <div style={{ background: ui.surface, borderRadius: "20px 20px 0 0", padding: 20,
            width: "100%", maxHeight: "85vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <p style={{ fontSize: 15, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>Re-upload College ID</p>
              <button onClick={() => { setReuploadOpen(false); setReuploadFile(null); setReuploadPreview(""); setReuploadError(""); setReuploadPath(""); setReuploadAiCheck(null); setReuploadChecking(false); }}
                style={{ background: "none", border: "none", color: ui.textTertiary, cursor: "pointer" }}><X size={18} strokeWidth={2} /></button>
            </div>

            <p style={{ fontSize: 12, color: ui.warning, background: ui.warningSoft, border: `1px solid ${ui.warningSoftBorder}`,
              borderRadius: ui.radius.sm, padding: "8px 10px", margin: "0 0 14px" }}>
              This can only be used once — make sure your new photo clearly shows both your ID and your signature before submitting.
            </p>

            <input id="reupload-file-input" type="file" accept={ACCEPT_ATTR} onChange={pickReuploadFile} style={{ display: "none" }} />

            {reuploadPreview ? (
              <img src={reuploadPreview} alt="Preview" style={{ width: "100%", borderRadius: ui.radius.card, marginBottom: 12, display: "block" }} />
            ) : (
              <label htmlFor="reupload-file-input" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: 6, border: `1px dashed ${ui.borderStrong}`, borderRadius: ui.radius.card, padding: "28px 16px", marginBottom: 12, cursor: "pointer" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={ui.textTertiary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span style={{ fontSize: 13, color: ui.textTertiary, fontWeight: 500 }}>Tap to choose a photo</span>
              </label>
            )}

            {reuploadFile && reuploadChecking && (
              <p style={{ fontSize: 12, color: ui.accent, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 12, height: 12, border: `2px solid ${ui.accentSoftBorder}`, borderTopColor: ui.accent, borderRadius: "50%", display: "inline-block", animation: "spin 0.8s linear infinite" }} />
                Checking your photo for a visible ID and signature…
              </p>
            )}

            {reuploadFile && !reuploadChecking && reuploadPath && !reuploadAiCheck && (
              <div style={{ background: ui.warningSoft, border: `1px solid ${ui.warningSoftBorder}`, borderRadius: ui.radius.button, padding: 12, marginBottom: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: ui.warning, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={14} strokeWidth={2} /> We couldn't automatically check this photo.
                </p>
                <p style={{ fontSize: 12, color: ui.warning, margin: "4px 0 0" }}>
                  Please make sure it's a clear photo of your full College ID card with your signature visible before submitting. If your card has no signature on it, sign your name on a blank paper, place it next to the card, and photograph both together.
                </p>
              </div>
            )}

            {reuploadFile && !reuploadChecking && reuploadAiCheck && (
              !reuploadAiCheck.isIdCard ? (
                <div style={{ background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, borderRadius: ui.radius.button, padding: 12, marginBottom: 12 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: ui.danger, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                    <AlertTriangle size={14} strokeWidth={2} /> This doesn't look like a College ID card.
                  </p>
                  <p style={{ fontSize: 12, color: ui.danger, margin: "4px 0 0" }}>
                    {reuploadAiCheck.notes || "Please upload a clear photo of your actual College ID."}
                  </p>
                </div>
              ) : !reuploadAiCheck.hasSignature ? (
                <div style={{ background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, borderRadius: ui.radius.button, padding: 12, marginBottom: 12 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: ui.danger, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                    <AlertTriangle size={14} strokeWidth={2} /> We couldn't see a signature on this photo.
                  </p>
                  <p style={{ fontSize: 12, color: ui.danger, margin: "4px 0 0" }}>
                    {reuploadAiCheck.notes || "Your signature must be visible in the photo. If your card has no signature on it, sign your name on a blank paper, place it next to the card, and photograph both together — then upload that photo."}
                  </p>
                </div>
              ) : (
                <p style={{ fontSize: 12, color: ui.success, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 6 }}>
                  <CheckCircle2 size={13} strokeWidth={2} /> Looks good — ID and signature both visible.
                </p>
              )
            )}

            {reuploadBlocked && (
              <label htmlFor="reupload-file-input" style={{ display: "inline-block", fontSize: 12, fontWeight: 600, color: ui.danger, textDecoration: "underline", marginBottom: 14, cursor: "pointer" }}>
                Tap here to choose a different photo
              </label>
            )}

            {reuploadError && <p style={{ fontSize: 12, color: ui.danger, margin: "0 0 10px" }}>{reuploadError}</p>}

            <button onClick={submitReupload} disabled={reuploadBusy || !reuploadFile || reuploadChecking || reuploadBlocked}
              style={{ width: "100%", background: ui.textPrimary, color: "#fff", border: "none", borderRadius: ui.radius.button,
                padding: "13px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", opacity: (reuploadBusy || !reuploadFile || reuploadChecking || reuploadBlocked) ? 0.6 : 1 }}>
              {reuploadBusy ? "Uploading…" : reuploadChecking ? "Analyzing…" : "Submit"}
            </button>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        </div>
      )}

      <StudentBottomNav hidePayments={payStatus === "approved" && !extraFeeDue} />
    </main>
  );
}
