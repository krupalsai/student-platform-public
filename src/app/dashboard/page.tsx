"use client";
import { useEffect, useState } from "react";
import LoadFailed from "@/components/student/LoadFailed";
import { ui } from "@/lib/student-ui";
import EnablePushButton from "@/components/push/EnablePushButton";
import StudentBottomNav from "@/components/student/StudentBottomNav";
import StudentSupportLink from "@/components/StudentSupportLink";
import StudentCallButton from "@/components/call/StudentCallButton";
import CoachMarkTour from "@/components/CoachMarkTour";
import CaseStatusCard from "@/components/student/CaseStatusCard";
import { useStudentData, PAY_STATUS } from "@/lib/hooks/useStudentData";
import {
  User, LogOut, Phone, School, BookOpen, CalendarDays, Hash,
  FileText, ChevronRight, AlertTriangle, RefreshCw, PenLine,
  Paperclip, X, AlertCircle, CreditCard, Shield, Linkedin,
  Newspaper, CheckCircle2, LifeBuoy,
} from "lucide-react";

const LINKEDIN_POST_URL = "https://www.linkedin.com/posts/krupal-sai_i-built-a-real-world-student-petition-platform-activity-7501959369874632705-mi6a?utm_source=social_share_send&utm_medium=android_app&rcm=ACoAADFRfV8BdHlN1A5tq-HuM9I4YPc_XkjPbUA&utm_campaign=copy_link";

function ProfileSheet({ profile, payment, onClose, onLogout, previewMode, isStaff }: {
  profile: any; payment: any; onClose: () => void; onLogout: () => void; previewMode: boolean; isStaff: boolean;
}) {
  const payStatus = payment?.status ?? "pending";
  const ps = PAY_STATUS[payStatus] ?? PAY_STATUS.pending;
  const initial = (profile?.full_name ?? "S").charAt(0).toUpperCase();
  const rows = [
    { icon: Hash, label: "Roll Number", value: profile?.roll_number },
    { icon: Phone, label: "Phone", value: profile?.phone },
    { icon: School, label: "College", value: profile?.college },
    { icon: BookOpen, label: "Branch", value: profile?.branch },
    { icon: CalendarDays, label: "Year", value: profile?.year ? `Year ${profile.year}` : null },
  ].filter(r => r.value);
  return (
    <>
      <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:60, backdropFilter:"blur(4px)", animation:"fadeIn 0.2s ease" }} />
      <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:ui.surface, borderRadius:"20px 20px 0 0", zIndex:61, paddingBottom:"calc(env(safe-area-inset-bottom,0px) + 16px)", animation:"slideUp 0.28s cubic-bezier(0.34,1.2,0.64,1)" }}>
        <div style={{ display:"flex", justifyContent:"flex-end", padding:"10px 14px 0" }}><button onClick={onClose} aria-label="Close" style={{ background:"none", border:"none", cursor:"pointer", color:ui.textTertiary, padding:6 }}><X size={18} strokeWidth={2} /></button></div>
        <div style={{ padding:"0 20px 14px", display:"flex", alignItems:"center", gap:14, borderBottom:`1px solid ${ui.divider}` }}>
          <div style={{ width:48, height:48, borderRadius:999, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:19, fontWeight:600, flexShrink:0, background:"linear-gradient(180deg,#a1a1aa,#7c7c85)" }}>{initial}</div>
          <div style={{ flex:1, minWidth:0 }}><p style={{ fontWeight:600, fontSize:15, color:ui.textPrimary, margin:0 }}>{profile?.full_name ?? "Student"}</p><p style={{ fontSize:12, color:ui.textSecondary, margin:"2px 0 0" }}>{[profile?.college, profile?.branch, profile?.year ? `Year ${profile.year}` : null].filter(Boolean).join(" · ")}</p></div>
          <span style={{ fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:ui.radius.pill, background:ps.bg, color:ps.text, border:`1px solid ${ps.border}` }}>{ps.label}</span>
        </div>
        {rows.map(r => <div key={r.label} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 20px", borderBottom:`1px solid ${ui.divider}` }}><span style={{ width:28, height:28, borderRadius:ui.radius.sm, background:ui.canvas, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, color:ui.textSecondary }}><r.icon size={15} strokeWidth={1.9} /></span><div><p style={{ fontSize:11, color:ui.textTertiary, fontWeight:500, margin:0 }}>{r.label}</p><p style={{ fontSize:14, color:ui.textPrimary, fontWeight:500, margin:"2px 0 0" }}>{r.value}</p></div></div>)}
        {!previewMode && <div style={{ padding:"14px 20px 0", display:"flex", flexDirection:"column", gap:8 }}><button onClick={() => { onClose(); window.location.href = "/profile"; }} style={{ width:"100%", background:ui.canvas, border:`1px solid ${ui.border}`, borderRadius:ui.radius.button, padding:"12px", display:"flex", alignItems:"center", justifyContent:"center", gap:8, cursor:"pointer", color:ui.textPrimary, fontWeight:500, fontSize:13.5 }}><FileText size={15} strokeWidth={1.8} /> View Profile & Documents</button>{isStaff && <button onClick={() => { onClose(); window.location.href = "/admin"; }} style={{ width:"100%", background:ui.canvas, border:`1px solid ${ui.border}`, borderRadius:ui.radius.button, padding:"12px", display:"flex", alignItems:"center", justifyContent:"center", gap:8, cursor:"pointer", color:ui.textPrimary, fontWeight:500, fontSize:13.5 }}><Shield size={15} strokeWidth={1.8} /> Back to Admin Console</button>}<StudentSupportLink /><button onClick={onLogout} style={{ width:"100%", background:"none", border:`1px solid ${ui.border}`, borderRadius:ui.radius.button, padding:"12px", display:"flex", alignItems:"center", justifyContent:"center", gap:8, cursor:"pointer", color:ui.danger, fontWeight:500, fontSize:13.5 }}><LogOut size={15} strokeWidth={1.8} /> Sign Out</button></div>}
      </div>
      <style>{`@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes slideUp{from{transform:translateX(-50%) translateY(100%)}to{transform:translateX(-50%) translateY(0)}}`}</style>
    </>
  );
}

export default function Dashboard() {
  const { router, previewMode, loading, loadError, reload, profile, payment, announcements, batch, payStatus, ps, isApproved, isSubmitted, isRegisteredWithBatch, isStaff, navigate, voiceCallsEnabled, authHeader, extraFee, extraFeeDue, nothingToPay } = useStudentData();
  const [showProfile, setShowProfile] = useState(false);
  const [newsList, setNewsList] = useState<any[]>([]);
  useEffect(() => {
    if (previewMode) return;
    fetch("/api/case-news", { headers: authHeader(), cache: "no-store" })
      .then(r => r.json())
      .then(j => { if (j.success && Array.isArray(j.data)) setNewsList(j.data); })
      .catch(() => {});
  }, [previewMode]);
  // The tile shows the newest news of the student's OWN batch first; another
  // batch's news only when theirs has none (the feed spans every batch).
  const latestNews = newsList.find(n => n.batch_slug === batch?.slug) ?? newsList[0] ?? null;
  // Set after mount: the server renders in ITS time zone, the phone in its own,
  // and a different string makes React throw the whole page away and rebuild it
  // (hydration error #418) on every load.
  const [today, setToday] = useState("");
  useEffect(() => { setToday(new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })); }, []);
  const [linkedinDismissed, setLinkedinDismissed] = useState(false);
  const [linkedinConfirmOpen, setLinkedinConfirmOpen] = useState(false);
  const isRejected = payStatus === "rejected";
  const isReupload = payStatus === "reupload_requested";
  const initial = (profile?.full_name ?? "S").charAt(0).toUpperCase();
  async function handleLogout() { if (previewMode) return; const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), 2500); try { await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` }, signal: controller.signal }); } catch {} finally { window.clearTimeout(timeout); localStorage.clear(); sessionStorage.clear(); window.location.replace("/login"); } }
  useEffect(() => {
    try { if (localStorage.getItem("sp_linkedin_dismissed") === "1") setLinkedinDismissed(true); } catch {}
  }, []);
  function askBeforeDismissLinkedin(e: React.MouseEvent) {
    e.stopPropagation();
    setLinkedinConfirmOpen(true);
  }
  function confirmDismissLinkedin() {
    try { localStorage.setItem("sp_linkedin_dismissed", "1"); } catch {}
    setLinkedinDismissed(true);
    setLinkedinConfirmOpen(false);
  }
  const idFlag = profile?.college_id_ai_flag;
  const idNeedsFix = !!idFlag && idFlag.isIdCard === true && idFlag.hasSignature === false;
  const actionBanner = (() => {
    if (loading) return null;
    if (!profile?.is_profile_complete) return { key: "complete", Icon: PenLine, title: "Complete your profile", sub: "Fill in missing details to proceed", onClick: () => navigate("/register") };
    if (idNeedsFix) return { key: "id-signature", Icon: AlertTriangle, title: "College ID needs a fix", sub: idFlag.notes || "We couldn't detect your signature on the uploaded ID — tap to re-upload", onClick: () => navigate("/correction") };
    if (isRejected) return { key: "rejected", Icon: AlertTriangle, title: "Payment rejected", sub: payment?.review_notes || "Tap to resubmit", onClick: () => navigate("/payments") };
    if (isReupload) return { key: "reupload", Icon: RefreshCw, title: "Reupload needed", sub: payment?.review_notes || "Tap to upload again", onClick: () => navigate("/payments") };
    if (payStatus === "pending" || payStatus === "pg_failed") return { key: "pay", Icon: CreditCard, title: "Payment required", sub: "Tap to pay your batch contribution", onClick: () => navigate("/payments") };
    // Closing the batch closes the correction window too (see the API's own
    // comment in api/profile/correction/route.ts) — don't show "Open" once
    // that's happened, or a student would tap through to a form that only
    // rejects on submit.
    // Paid and nothing pending: not a task — rendered as the "all set" card,
    // with the still-open correction window as a gentle hint.
    if (isApproved && batch?.status !== "closed") return { key: "correction", Icon: CheckCircle2, title: "You're all set — payment approved", sub: "Spotted a mistake in your details? Tap to fix it while the correction window is open.", onClick: () => navigate("/correction") };
    return null;
  })();
  const progress = (() => {
    const steps = [
      { key: "profile", done: !!profile?.is_profile_complete, Icon: PenLine, title: "Your Details", sub: "Complete your registration", onClick: () => navigate("/register") },
      { key: "id", done: !!profile?.college_id_path && !idNeedsFix, Icon: Shield, title: "College ID", sub: "Clear photo with your signature", onClick: () => navigate(profile?.is_profile_complete ? "/correction" : "/register") },
      { key: "pay", done: isApproved, Icon: CreditCard, title: "Batch Fee", sub: isSubmitted ? "Being verified" : "Pay securely in the app", onClick: () => navigate("/payments") },
    ];
    const done = steps.filter(x => x.done).length;
    return { pct: Math.round((done / steps.length) * 100), todo: steps.filter(x => !x.done) };
  })();
  const urgentAnn = announcements.filter((a: any) => a.priority === "urgent");
  // One-line next step for the batch card (batches with no court case).
  const batchNextStep = payStatus === "pg_failed"
    ? "Payment failed — tap to try again"
    : payStatus === "pending"
      ? "Fee pending — tap to pay"
      : isSubmitted
        ? "Payment submitted — verifying"
        : isApproved
          ? "Fee approved — all set"
          : "View batch details";
  const batchCardTarget = (payStatus === "pg_failed" || payStatus === "pending") ? "/payments" : "/batch";
  return (
    <main style={{ minHeight:"100vh", background:ui.canvas, paddingBottom: 108, fontFamily:"'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      {loadError && <LoadFailed onRetry={reload} />}
      {previewMode && <div style={{ background:ui.textPrimary, color:"#fff", padding:"8px 16px", textAlign:"center", fontSize:11.5, fontWeight:500, letterSpacing:0.2 }}>Admin Preview — read only, this is {profile?.full_name ?? "the student"}&apos;s real dashboard</div>}
      <div style={{ padding:"44px 20px 4px" }}>
        <p style={{ color:ui.textTertiary, fontSize:13, fontWeight:600, margin:"0 0 2px", letterSpacing:0.2, textTransform:"uppercase" }}>{today}</p>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12 }}>
          {loading
            ? <div style={{ height:36, width:180, background:"#e5e5ea", borderRadius:8 }} />
            : <h1 style={{ color:ui.textPrimary, fontSize:34, fontWeight:700, margin:0, lineHeight:1.15, letterSpacing:-0.8, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1, minWidth:0 }}>{(profile?.full_name ?? "Student").split(" ")[0]}</h1>}
          <button onClick={() => !loading && setShowProfile(true)} data-tour="home-avatar" aria-label="Your profile" style={{ width:40, height:40, borderRadius:999, background:"linear-gradient(180deg,#a1a1aa,#7c7c85)", border:"none", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:16, fontWeight:600, flexShrink:0, cursor:"pointer" }}>{loading ? <User size={18} strokeWidth={1.8} /> : initial}</button>
        </div>
        {!loading && (
          <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:8, flexWrap:"wrap" }}>
            <span style={{ display:"inline-flex", alignItems:"center", gap:6, background:ui.surface, borderRadius:999, padding:"4px 11px" }}>
              <span style={{ width:7, height:7, borderRadius:999, background:ps.dot }} />
              <span style={{ color:ui.textPrimary, fontSize:12, fontWeight:600 }}>{ps.label}{isSubmitted ? " · verifying" : ""}</span>
            </span>
            {profile?.college && <span style={{ color:ui.textSecondary, fontSize:12.5 }}>{profile.college}{batch?.name ? ` · ${batch.name}` : ""}</span>}
          </div>
        )}
      </div>
      <div style={{ padding:"18px 16px", display:"flex", flexDirection:"column", gap:14 }}>
        {/* 1. Urgent notices — only when an admin posted one. */}
        {urgentAnn.map((a: any) => <div key={a.id} style={{ background:ui.dangerSoft, border:`1px solid ${ui.dangerSoftBorder}`, borderRadius:ui.radius.card, padding:"14px 16px" }}><p style={{ color:ui.danger, fontWeight:600, fontSize:13, marginBottom:4, display:"flex", alignItems:"center", gap:6 }}><AlertCircle size={14} strokeWidth={2} /> {a.title}</p><p style={{ color:ui.danger, fontSize:12, lineHeight:1.6, margin:0, opacity:0.85 }}>{a.body}</p>{a.attachment_url && <a href={a.attachment_url} target="_blank" rel="noopener noreferrer" style={{ display:"inline-flex", alignItems:"center", gap:6, marginTop:8, background:"#fff", color:ui.danger, fontSize:12, fontWeight:500, padding:"6px 10px", borderRadius:ui.radius.sm, textDecoration:"none", border:`1px solid ${ui.dangerSoftBorder}` }}><Paperclip size={12} strokeWidth={2} /> {a.attachment_name ?? "View Document"}</a>}</div>)}

        {/* 2. Something went wrong and needs the student (rejected, ID fix, reupload). */}
        {!loading && actionBanner && ["id-signature","rejected","reupload"].includes(actionBanner.key) && (
          <button onClick={actionBanner.onClick} style={{ width:"100%", background:ui.dangerSoft, border:`1px solid ${ui.dangerSoftBorder}`, borderRadius:ui.radius.card, padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:40, height:40, borderRadius:ui.radius.icon, background:"#fff", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><actionBanner.Icon size={18} strokeWidth={1.9} color={ui.danger} /></div>
              <div style={{ textAlign:"left" }}>
                <p style={{ color:ui.danger, fontWeight:700, fontSize:14, margin:0 }}>{actionBanner.title}</p>
                <p style={{ color:ui.danger, fontSize:12, margin:"2px 0 0" }}>{actionBanner.sub}</p>
              </div>
            </div>
            <ChevronRight size={18} strokeWidth={1.8} color={ui.danger} />
          </button>
        )}

        {/* 3. Get started — progress through the three real steps. */}
        {!loading && progress.pct < 100 && (
          <div>
            <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", margin:"4px 4px 10px" }}>
              <h2 style={{ fontSize:20, fontWeight:700, color:ui.textPrimary, margin:0, letterSpacing:-0.3 }}>Get Started</h2>
              <span style={{ fontSize:13, fontWeight:600, color:ui.textTertiary }}>{progress.pct}% done</span>
            </div>
            <div style={{ height:7, borderRadius:999, background:"#e5e5ea", overflow:"hidden", margin:"0 4px 14px" }}><div style={{ width:`${progress.pct}%`, height:"100%", background:ui.accent, borderRadius:999, transition:"width .4s ease" }} /></div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              {progress.todo.map((st, i) => (
                <button key={st.key} onClick={st.onClick} style={{ background:ui.surface, border:"none", boxShadow:ui.shadow.card, borderRadius:ui.radius.card, padding:"18px 16px", display:"flex", flexDirection:"column", alignItems:"flex-start", gap:14, cursor:"pointer", textAlign:"left", minWidth:0 }}>
                  <div style={{ width:48, height:48, borderRadius:ui.radius.icon+2, background:ui.tints[i % ui.tints.length].bg, display:"flex", alignItems:"center", justifyContent:"center" }}><st.Icon size={21} strokeWidth={1.8} color={ui.tints[i % ui.tints.length].fg} /></div>
                  <div>
                    <p style={{ color:ui.textPrimary, fontWeight:700, fontSize:15, margin:0 }}>{st.title}</p>
                    <p style={{ color:ui.textSecondary, fontSize:12.5, margin:"4px 0 0", lineHeight:1.4 }}>{st.sub}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Main fee approved, the batch's separate second payment is switched on and unpaid. */}
        {!loading && progress.pct === 100 && extraFeeDue && (
          <button onClick={() => navigate("/payments")} style={{ width:"100%", background:ui.surface, border:"none", boxShadow:ui.shadow.card, borderRadius:ui.radius.card, padding:"16px", display:"flex", alignItems:"center", gap:12, cursor:"pointer", textAlign:"left" }}>
            <div style={{ width:44, height:44, borderRadius:ui.radius.icon, background:ui.accent, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><CreditCard size={20} strokeWidth={1.9} color="#fff" /></div>
            <div style={{ flex:1 }}>
              <p style={{ color:ui.textPrimary, fontWeight:700, fontSize:15, margin:0 }}>{extraFee?.label ?? "Second payment"} · ₹{Number(extraFee?.amount ?? 0).toLocaleString("en-IN")}</p>
              <p style={{ color:ui.textSecondary, fontSize:12.5, margin:"3px 0 0", lineHeight:1.4 }}>Item 2 of your order — your batch fee is already paid. Tap to pay.</p>
            </div>
            <ChevronRight size={18} strokeWidth={1.8} color={ui.textTertiary} />
          </button>
        )}

        {/* All three steps done: a calm confirmation, with the correction window as a hint. */}
        {!loading && progress.pct === 100 && !extraFeeDue && !(actionBanner && ["id-signature","rejected","reupload"].includes(actionBanner.key)) && (
          <button onClick={() => { if (actionBanner?.key === "correction") actionBanner.onClick(); }} style={{ width:"100%", background:ui.surface, border:"none", boxShadow:ui.shadow.card, borderRadius:ui.radius.card, padding:"16px", display:"flex", alignItems:"center", gap:12, cursor:actionBanner?.key === "correction" ? "pointer" : "default", textAlign:"left" }}>
            <div style={{ width:44, height:44, borderRadius:ui.radius.icon, background:ui.success, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><CheckCircle2 size={20} strokeWidth={1.9} color="#fff" /></div>
            <div style={{ flex:1 }}>
              <p style={{ color:ui.textPrimary, fontWeight:700, fontSize:15, margin:0 }}>You&apos;re all set</p>
              <p style={{ color:ui.textSecondary, fontSize:12.5, margin:"3px 0 0", lineHeight:1.4 }}>{actionBanner?.key === "correction" ? "Payment approved. Spotted a mistake in your details? Tap to fix it while the correction window is open." : "Nothing to do right now. We'll notify you when something changes."}</p>
            </div>
            {actionBanner?.key === "correction" && <ChevronRight size={18} strokeWidth={1.8} color={ui.textTertiary} />}
          </button>
        )}
        {!loading && !previewMode && <EnablePushButton />}

        {/* 4. The case — the reason students open the app. */}
        {!loading && <CaseStatusCard batch={batch} authHeader={authHeader} />}

        {/* 4b. Batches with no court case linked (new Batch 2s): the case card
            above renders nothing, which left the home looking empty on tall
            phones. A batch card fills that space instead. */}
        {!loading && batch && !batch.case_number && (
          <button onClick={() => navigate(batchCardTarget)} style={{ width:"100%", background:ui.surface, border:"none", boxShadow:ui.shadow.card, borderRadius:ui.radius.card, padding:"16px", display:"flex", alignItems:"center", gap:12, cursor:"pointer", textAlign:"left" }}>
            <div style={{ width:44, height:44, borderRadius:ui.radius.icon, background:ui.tints[0].bg, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><School size={20} strokeWidth={1.9} color={ui.tints[0].fg} /></div>
            <div style={{ flex:1, minWidth:0 }}>
              <p style={{ color:ui.textPrimary, fontWeight:700, fontSize:15, margin:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{batch.name ?? "Your batch"}</p>
              <p style={{ color:ui.textSecondary, fontSize:12.5, margin:"3px 0 0", lineHeight:1.5 }}>
                <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontWeight:600, color:ui.textPrimary }}><span style={{ width:7, height:7, borderRadius:999, background:ps.dot, display:"inline-block" }} />{ps.label}</span>
                <br />{batchNextStep}
              </p>
            </div>
            <ChevronRight size={18} strokeWidth={1.8} color={ui.textTertiary} />
          </button>
        )}

        {/* 5. Things not already in the bottom tab bar (Batch and Messages are tabs there). */}
        <h2 style={{ fontSize:20, fontWeight:700, color:ui.textPrimary, margin:"6px 4px -2px", letterSpacing:-0.3 }}>Quick Links</h2>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          <HomeTile tint={2} Icon={Newspaper} title="Case News" sub={latestNews ? latestNews.title : "What happened, when"} onClick={() => navigate("/news")} />
          <HomeTile tint={3} Icon={LifeBuoy} title="Support" sub="Instant answers" onClick={() => navigate("/support")} />
        </div>

        {/* "Call an admin" was removed (live report: it never actually
            connects — an admin's console tab isn't always open to answer).
            This stays mounted, invisible in the common case, only so a
            student can still receive/answer an admin-INITIATED callback.
            Calling is an ACTION taken as the student, so it stays hidden in
            admin preview (item #72) exactly like every other mutation there. */}
        {!previewMode && voiceCallsEnabled && <StudentCallButton />}

        {!linkedinDismissed && (
          <div style={{ display:"flex", alignItems:"center", gap:10, background:ui.surface, border:`1px solid ${ui.border}`, borderRadius:ui.radius.card, padding:"10px 12px" }}>
            <button onClick={() => window.open(LINKEDIN_POST_URL, "_blank", "noopener,noreferrer")} aria-label="Open Student Platform LinkedIn post" style={{ flex:1, minWidth:0, display:"flex", alignItems:"center", gap:10, background:"none", border:"none", padding:0, cursor:"pointer", textAlign:"left" }}>
              <Linkedin size={17} strokeWidth={1.8} color={ui.textSecondary} style={{ flexShrink:0 }} />
              <span style={{ color:ui.textSecondary, fontSize:12.5, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>Share your feedback on LinkedIn</span>
            </button>
            <button onClick={askBeforeDismissLinkedin} aria-label="Dismiss this card" style={{ width:24, height:24, borderRadius:999, background:ui.canvas, border:"none", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", padding:0, flexShrink:0 }}><X size={12} strokeWidth={2} color={ui.textTertiary} /></button>
          </div>
        )}
      </div>
      {linkedinConfirmOpen && (
        <>
          <div onClick={() => setLinkedinConfirmOpen(false)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:70, backdropFilter:"blur(4px)" }} />
          <div style={{ position:"fixed", top:"50%", left:"50%", transform:"translate(-50%,-50%)", width:"calc(100% - 40px)", maxWidth:340, background:ui.surface, borderRadius:ui.radius.card, zIndex:71, padding:"22px 20px 18px", textAlign:"center" }}>
            <p style={{ fontSize:15, fontWeight:600, color:ui.textPrimary, margin:0 }}>Have you given your feedback?</p>
            <p style={{ fontSize:12.5, color:ui.textSecondary, margin:"8px 0 0", lineHeight:1.5 }}>A quick react or comment on our LinkedIn post helps other students in the same situation find this platform.</p>
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:18 }}>
              <button onClick={() => { setLinkedinConfirmOpen(false); window.open(LINKEDIN_POST_URL, "_blank", "noopener,noreferrer"); }} style={{ width:"100%", background:ui.accent, border:"none", borderRadius:ui.radius.button, padding:"11px", color:"#fff", fontWeight:600, fontSize:13.5, cursor:"pointer" }}>Not yet — take me there</button>
              <button onClick={confirmDismissLinkedin} style={{ width:"100%", background:"none", border:`1px solid ${ui.border}`, borderRadius:ui.radius.button, padding:"11px", color:ui.textSecondary, fontWeight:500, fontSize:13.5, cursor:"pointer" }}>Yes, I have — dismiss</button>
            </div>
          </div>
        </>
      )}
      {showProfile && profile && <ProfileSheet profile={profile} payment={payment} onClose={() => setShowProfile(false)} onLogout={handleLogout} previewMode={previewMode} isStaff={isStaff} />}
      <StudentBottomNav previewMode={previewMode} hidePayments={nothingToPay} />
      {!loading && !previewMode && <CoachMarkTour tourKey="home" steps={[{ selector: '[data-tour="home-avatar"]', title: "Your profile", text: "Tap here any time to see your details or sign out." },{ selector: '[data-tour="nav-home"]', title: "Home", text: "Come back here any time — it shows exactly what you need to do next." },{ selector: '[data-tour="nav-batch"]', title: "Batch", text: "Full detail on your batch: seats, status, and the Route Map." },{ selector: '[data-tour="nav-payments"]', title: "Payments", text: "Pay your fee, resubmit if rejected, or check your payment status here." },{ selector: '[data-tour="nav-messages"]', title: "Messages", text: "Announcements and your batch discussion." }]} />}
    </main>
  );
}

/** One tile of the Home quick-links grid: tinted icon circle, title, one line. */
function HomeTile({ Icon, title, sub, onClick, tour, tint = 0 }: { Icon: React.ComponentType<any>; title: string; sub: string; onClick: () => void; tour?: string; tint?: number }) {
  const t = ui.tints[tint % ui.tints.length];
  return (
    <button onClick={onClick} data-tour={tour} style={{ background:ui.surface, border:"none", boxShadow:ui.shadow.card, borderRadius:ui.radius.card, padding:"16px", display:"flex", flexDirection:"column", alignItems:"flex-start", gap:12, cursor:"pointer", textAlign:"left", minWidth:0 }}>
      <div style={{ width:44, height:44, borderRadius:ui.radius.icon, background:t.bg, display:"flex", alignItems:"center", justifyContent:"center" }}><Icon size={19} strokeWidth={1.8} color={t.fg} /></div>
      <div style={{ minWidth:0, width:"100%" }}>
        <p style={{ color:ui.textPrimary, fontWeight:700, fontSize:14, margin:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{title}</p>
        <p style={{ color:ui.textSecondary, fontSize:12, margin:"3px 0 0", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{sub}</p>
      </div>
    </button>
  );
}
