"use client";
import { Suspense, useEffect, useRef, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import FAQModal from "@/components/FAQModal";
import CoachMarkTour from "@/components/CoachMarkTour";
import { decideDestination } from "@/lib/route-decision";
import { ShieldCheck, AlertTriangle, CheckCircle2 } from "lucide-react";
import { ALLOWED_IMAGE_MIME, ACCEPT_ATTR } from "@/lib/image-types";
import { ui } from "@/lib/student-ui";
import { firstActiveBatchForCollege } from "@/lib/registration-batch";
import { detectNotifState } from "@/lib/push/notification-state";
import { createLocalPushSubscription } from "@/lib/push/subscribe-client";

const BRANCHES = ["CSE","ECE","EEE","MECH","CIVIL","IT","CSE-AI","CSE-DS","CSE-CS"];
const YEARS    = ["2025","2026"];
const ALLOWED_TYPES = ALLOWED_IMAGE_MIME as readonly string[];

interface BatchPayment { fee_amount: number; slug: string; status?: string; college?: string; }

type Step = "verify" | "profile" | "payment";

function RegisterPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // Returning from an external UPI app reloads this page. Without restoring the
  // step, a fully-registered student is dropped back onto the registration form
  // and loses the payment upload page (P0-1). Restore it synchronously from
  // sessionStorage so there's no flash; the effect below re-confirms against the
  // server (and routes an already-approved student to the dashboard). Edit mode
  // always starts on the profile form.
  const [step, setStep] = useState<Step>(() => {
    if (typeof window === "undefined") return "profile";
    if (searchParams.get("edit") === "1") return "profile";
    // A fresh WhatsApp link always starts on the phone+OTP confirmation
    // step — the token isn't trusted to bootstrap a session on its own
    // any more (see requestVerifyOtp/confirmVerifyOtp below). This wins
    // over any stale sp_reg_step, same reasoning as the existing "fresh
    // ?token= wins over localStorage" rule elsewhere on this page.
    if (searchParams.get("token")) return "verify";
    return sessionStorage.getItem("sp_reg_step") === "payment" ? "payment" : "profile";
  });
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [showFAQ, setShowFAQ] = useState(false);
  const [form, setForm] = useState({ full_name: (typeof window !== "undefined" ? (window.sessionStorage.getItem("sp_signup_name") ?? "") : ""), father_name:"", gender:"", phone:"", college:"", roll_number:"", branch:"", year:"", home_address:"" });
  const [collegeIdFile,    setCollegeIdFile]    = useState<File | null>(null);
  const [collegeIdPreview, setCollegeIdPreview] = useState("");
  const [collegeIdPath,    setCollegeIdPath]    = useState("");
  const [collegeIdError,   setCollegeIdError]   = useState("");
  const [aiChecking,         setAiChecking]         = useState(false);
  const [aiCheck,            setAiCheck]            = useState<{ isIdCard: boolean; hasSignature: boolean; notes: string | null } | null>(null);
  const [batch,        setBatch]        = useState<BatchPayment | null>(null);
  const [batchLoading, setBatchLoading] = useState(true);
  const [batchError,   setBatchError]   = useState("");
  // The standalone phone/OTP /login path may not have a batch link, so a
  // brand-new student can choose their college instead of hitting a dead end.
  const [needsCollegePick, setNeedsCollegePick] = useState(false);
  // A student can hold a valid cookie session with no copy of the token in
  // localStorage (the cookie is HttpOnly; the token is only mirrored into
  // localStorage by some sign-in paths). /login accepts that session and sends
  // them here, so this page must accept it too — otherwise it bounces them
  // back and the two screens redirect each other forever (the "blinking").
  const [cookieSession, setCookieSession] = useState(false);
  const [collegeOptions,   setCollegeOptions]   = useState<{ id: string; name: string }[]>([]);
  const [pickedCollege,    setPickedCollege]    = useState("");
  const [collegePickBusy,  setCollegePickBusy]  = useState(false);
  // Unlisted-college request: a student whose college is not in the list
  // is never blocked. They type the college name and send it as a request
  // (POST /api/college-requests) — the admin is notified and the student
  // gets a confirmation, not a dead end.
  const [otherCollegeName, setOtherCollegeName] = useState("");
  const [collegeRequestSent, setCollegeRequestSent] = useState(false);
  const [collegeRequestBusy, setCollegeRequestBusy] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [errors,        setErrors]        = useState<Record<string,string>>({});
  const [pgLoading, setPgLoading] = useState(false);
  const isEditMode = searchParams.get("edit") === "1";
  const [editLocked, setEditLocked] = useState(false); // true if payment already submitted — blocks edit
  // Phone+OTP confirmation step (see step === "verify" below) — confirms
  // whoever opened this WhatsApp link controls the number it was issued to.
  const [verifyPhone,  setVerifyPhone]  = useState("");
  const [verifyOtp,    setVerifyOtp]    = useState("");
  const [verifySent,   setVerifySent]   = useState(false);
  const [verifyBusy,   setVerifyBusy]   = useState(false);
  const [verifyError,  setVerifyError]  = useState("");
  const [verifyPhonePrefilled, setVerifyPhonePrefilled] = useState(false);
  // Notification gate: the confirmation code arrives as an app
  // notification, so the gate runs BEFORE anything is sent. If the device
  // can't receive notifications, guide them instead — WhatsApp only hands
  // out the registration/download link, never codes.
  const [verifyNotifGate, setVerifyNotifGate] = useState<"ok" | "prompt" | "denied" | "unsupported">("ok");
  const [verifyGateAcked, setVerifyGateAcked] = useState(false);
  const [verifyViaWa, setVerifyViaWa] = useState(false);
  // There is deliberately no "is <gateway> ready" flag here any more. This
  // page tried to know that three times over — a PhonePe health flag, then a
  // Cashfree flag — and each time the gateway was swapped underneath it
  // (PhonePe -> Cashfree -> Razorpay) the flag kept pointing at the RETIRED
  // gateway and hid the Pay button completely, with no fallback. Confirmed
  // live: /register had zero references to Razorpay while Cashfree was
  // already off, so every student who finished the form saw an empty payment
  // step and could not pay — while /pay/[slug] (below) worked the whole time.
  // /pay/[slug] is the one place that is allowed to know which gateway is
  // live; this page's only job is to get the student there.

  const authH = () => ({ "Content-Type":"application/json", Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });


  // P0-1 — payment session restore. If the student has ALREADY completed
  // registration, they must resume at the payment step, never be sent back to
  // the registration form (which is what happened on the reload triggered by
  // returning from a UPI app). Source of truth is the server, so this survives
  // a cleared sessionStorage / different tab too.
  useEffect(() => {
    if (isEditMode) return;
    // A fresh WhatsApp link must always land on the verify step, never
    // silently resume payment under whatever unrelated session happens to
    // be sitting in localStorage (a previous test account, a shared/kiosk
    // device, etc). Same "fresh ?token= wins" rule the loadBatch effect
    // already applies — this effect needs its own copy of the guard since
    // it reads localStorage independently and runs in parallel.
    if (searchParams.get("token")) return;
    const t = localStorage.getItem("sp_token") ?? "";
    let cancelled = false;
    (async () => {
      try {
        const p = await fetch("/api/profile", { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" }).then(r => r.json());
        if (cancelled || !p?.success || !p.data?.is_profile_complete) {
          // Genuinely incomplete registration → stay on the form; clear any
          // stale resume flag so we don't wrongly skip it later.
          if (!cancelled) sessionStorage.removeItem("sp_reg_step");
          return;
        }
        // The install-time hand-off is spent once the profile is complete.
        // Leaving it behind is what made every app open replay registration:
        // HomeRedirect honoured it over the session, and this page skips its
        // own completeness check whenever a ?token= is present.
        localStorage.removeItem("sp_pending_registration_token");
        const pay = await fetch("/api/payments/status", { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" }).then(r => r.json()).catch(() => null);
        const st = pay?.data?.status ?? null;
        if (cancelled) return;
        setPaymentStatus(st);
        if (st === "approved") { localStorage.setItem("sp_reg_complete", "1"); router.replace("/dashboard"); return; }
        // Registered but not yet approved → resume the payment upload page.
        setStep("payment");
        sessionStorage.setItem("sp_reg_step", "payment");
      } catch { /* leave the form as-is on a network hiccup */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // The bot already knows exactly which number this link is for — the
  // registration token was issued to it (issueRegistrationToken). Making a
  // student retype a number the system already has is friction with no
  // security benefit (the OTP step right after this is the actual check).
  // Pre-fill it, but leave it a normal editable input: someone forwarded
  // the link, or typing it slightly wrong, should still be able to fix it
  // rather than being stuck with a value they can't touch.
  useEffect(() => {
    const regToken = searchParams.get("token");
    if (!regToken || step !== "verify") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/registration-tokens/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: regToken }),
      });
        const data = await res.json();
        if (cancelled || !data?.success || !data.data?.phone) return;
        setVerifyPhone(p => p ? p : data.data.phone);
        setVerifyPhonePrefilled(true);
      } catch { /* leave the field blank on a network hiccup — not fatal, just typed manually */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    const regToken = searchParams.get("token");
    const t = localStorage.getItem("sp_token");
    if (!t && !regToken && !cookieSession) {
      let gateCancelled = false;
      fetch("/api/auth/session", { cache: "no-store" })
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          if (gateCancelled) return;
          if (j?.success) setCookieSession(true);
          else router.replace("/login");
        })
        .catch(() => { if (!gateCancelled) router.replace("/login"); });
      return () => { gateCancelled = true; };
    }
    let settled = false;
    const timeoutId = setTimeout(() => { if (!settled) { settled=true; setBatchLoading(false); setBatchError("Could not load payment details."); } }, 10000);
    const applyBatch = (data: any, slugUsed: string) => {
      if (settled) return; settled=true; clearTimeout(timeoutId);
      const resolvedSlug = data.slug || slugUsed;
      setBatch({ fee_amount: Number(data.fee_amount)||0, slug: resolvedSlug, status: data.status??"active", college: data.college??"" });
      setBatchLoading(false);
      // Every path that resolves a batch (website batch link, WhatsApp/token
      // bootstrap, or legacy slug lookup) must persist the slug the same way —
      // PATCH /api/profile reads it from localStorage at submit time, not
      // from React state. Previously only the legacy path did this
      // explicitly; the token-bootstrap path left batch_id permanently
      // null for every WhatsApp-originated registration. Doing it once
      // here, in the shared function, means no future caller can
      // reintroduce this by forgetting to persist it themselves.
      if (resolvedSlug) {
        localStorage.setItem("sp_batch_slug", resolvedSlug);
        sessionStorage.setItem("sp_batch_slug", resolvedSlug);
      }
      // College is determined entirely by which batch link the student
      // opened — no manual dropdown, no risk of picking the wrong one.
      if (data.college) setForm(f => ({ ...f, college: data.college }));
    };
    const fail = (msg: string) => { if (settled) return; settled=true; clearTimeout(timeoutId); setBatchLoading(false); setBatchError(msg); };
    async function loadBatch() {
      // A fresh ?token= no longer auto-bootstraps a session here — the
      // student must confirm their phone + OTP first (step === "verify"
      // below, via requestVerifyOtp/confirmVerifyOtp). Once that succeeds
      // it calls applyBatch itself with the same data this used to fetch
      // via /api/registration-tokens/start. Nothing to load on this
      // effect's pass while sitting on the verify step.
      if (regToken) {
        setBatchLoading(false);
        return;
      }
      let sessionToken = t ?? "";
      let slug: string | null = null;
      // A direct PWA batch link must win over cached state so an old batch
      // slug cannot override the link the student or admin just opened.
      if (!slug) slug = searchParams.get("batch");
      if (!slug) slug = sessionStorage.getItem("sp_batch_slug") ?? localStorage.getItem("sp_batch_slug");
      if (slug) {
        localStorage.setItem("sp_batch_slug", slug); sessionStorage.setItem("sp_batch_slug", slug);
        try { const r = await fetch(`/api/batches/by-slug/${encodeURIComponent(slug)}`,{cache:"no-store"}); const j=await r.json(); if(j.success&&j.data){applyBatch(j.data,slug);return;} } catch {}
      }
      try {
        const r = await fetch("/api/profile",{headers:{Authorization:`Bearer ${sessionToken}`},cache:"no-store"}); const j=await r.json();
        if(j.success&&j.data?.batches){applyBatch(j.data.batches,j.data.batches.slug??slug??"");return;}
        // A student who arrived via a batch link/token but whose batch has
        // since closed already has a college on file — waitlist them for it
        // directly, same as before. A student with NO college on file at all
        // (arrived via plain phone/OTP /login, no link ever opened) can't be
        // waitlisted for an unknown college — let them pick one instead.
        if (!j.data?.college) {
          if (settled) return; settled = true; clearTimeout(timeoutId);
          setNeedsCollegePick(true);
          setBatchLoading(false);
          return;
        }
        // College is known but no batch resolved — the profile's college
        // often comes from an unconsumed registration token (see
        // getStudentProfileRaw), whose batch this page never sees. Before
        // waitlisting, try the college's active batch (same endpoint the
        // college picker uses): a student whose batch is open must be able
        // to register, not be waitlisted. Live incident 11 Nov 2026: a
        // GNITC student holding a token for GNITC Batch 2 (active) was told
        // registrations were paused, because the page never looked the
        // batch up.
        try {
          const br = await fetch(`/api/batches?college=${encodeURIComponent(j.data.college)}`, { cache: "no-store" });
          const bj = await br.json();
          const active = firstActiveBatchForCollege(bj?.success ? (bj.data ?? []) : [], j.data.college);
          if (active) { applyBatch(active, active.slug); return; }
        } catch {}
        // No active batch — join the waiting list instead of a dead end.
        // Same mechanism as the WhatsApp "no active batch" path. Pass the
        // college the page already knows: the join reads the profile row
        // (which has no college for a token-registered student) and 409s
        // without it — and the student was then told they'd been waitlisted
        // when no queue row had been created.
        try {
          const wr = await fetch("/api/waitlist/join", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ college: j.data.college }),
          });
          const wj = await wr.json();
          if (wj.success) {
            fail(
              `Registration is temporarily paused for your college.\n\n` +
              `You've been added to the waiting list${wj.data.alreadyWaiting ? "" : ` (position ${wj.data.position})`}. ` +
              `You'll be notified on WhatsApp as soon as the next batch opens — no need to check back here.`
            );
            return;
          }
        } catch {}
        fail("Registrations for your college are currently paused, and we couldn't add you to the waiting list just now. Please try again.");
      } catch { fail("Network error while loading."); }
    }
    loadBatch();
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cookieSession]);

  // Load the college list only once actually needed — every other entry
  // path (shared website batch link or WhatsApp registration token) already
  // resolves a college on its own and never touches this.
  useEffect(() => {
    if (!needsCollegePick) return;
    fetch("/api/settings/colleges", { cache: "no-store" })
      .then(r => r.json())
      .then(j => { if (j?.success && Array.isArray(j.data)) setCollegeOptions(j.data); })
      .catch(() => {});
  }, [needsCollegePick]);

  async function pickCollege() {
    if (!pickedCollege || collegePickBusy) return;
    setCollegePickBusy(true);
    setBatchError("");
    try {
      const r = await fetch(`/api/batches?college=${encodeURIComponent(pickedCollege)}`, { cache: "no-store" });
      const j = await r.json();
      const active = j?.success ? (j.data ?? [])[0] : null;
      if (active) {
        setBatch({ fee_amount: Number(active.fee_amount)||0, slug: active.slug, status: active.status??"active", college: active.college??pickedCollege });
        localStorage.setItem("sp_batch_slug", active.slug);
        sessionStorage.setItem("sp_batch_slug", active.slug);
        setForm(f => ({ ...f, college: active.college ?? pickedCollege }));
        setNeedsCollegePick(false);
        return;
      }
      // No active batch for this college yet — same waiting-list path the
      // WhatsApp/link flow uses, just with the college passed explicitly
      // since profiles.college has never been set for this student.
      const t = localStorage.getItem("sp_token");
      const wr = await fetch("/api/waitlist/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t ?? ""}` },
        body: JSON.stringify({ college: pickedCollege }),
      });
      const wj = await wr.json();
      if (wj.success) {
        setNeedsCollegePick(false);
        setBatchError(
          `Registration is temporarily paused for ${pickedCollege}.\n\n` +
          `You've been added to the waiting list${wj.data.alreadyWaiting ? "" : ` (position ${wj.data.position})`}. ` +
          `You'll be notified on WhatsApp as soon as the next batch opens — no need to check back here.`
        );
      } else {
        setBatchError(wj.error ?? "Couldn't join the waiting list. Please try again.");
      }
    } catch {
      setBatchError("Network error — please try again.");
    } finally {
      setCollegePickBusy(false);
    }
  }

  // Unlisted college: send the college name as a request to the admin.
  // The student is never blocked — they get a confirmation and the admin
  // is notified (WhatsApp) and the request is stored (college_requests).
  async function requestCollege() {
    const collegeName = otherCollegeName.trim();
    if (!collegeName || collegeRequestBusy) return;
    if (!form.full_name.trim() || !form.phone.trim()) {
      setBatchError("Please fill your name and phone number above first, so we know who is asking.");
      return;
    }
    setCollegeRequestBusy(true);
    setBatchError("");
    try {
      const res = await fetch("/api/college-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.full_name.trim(), phone: form.phone.replace(/\D/g, "").slice(-10), college_name: collegeName }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error ?? "Could not send your request.");
      setCollegeRequestSent(true);
      setNeedsCollegePick(false);
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : "Could not send your request. Please try again.");
    } finally {
      setCollegeRequestBusy(false);
    }
  }

  // Edit-mode prefill: load the student's existing profile + current
  // payment status. Editing is only allowed while payment is still
  // "pending" (not yet submitted) — once money is moving, the printed
  // petition/certificate paperwork downstream depends on the data being
  // final, so edits are locked from that point on.
  useEffect(() => {
    if (!isEditMode) return;
    const t = localStorage.getItem("sp_token");
    if (!t) return;
    Promise.all([
      fetch("/api/profile", { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json()),
      fetch("/api/payments/status", { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json()),
    ]).then(([p, pay]) => {
      const payStatus = pay?.data?.status ?? "pending";
      if (payStatus !== "pending") {
        setEditLocked(true);
        return;
      }
      if (p.success && p.data) {
        const d = p.data;
        setForm({
          full_name: d.full_name ?? "", father_name: d.father_name ?? "", gender: d.gender ?? "",
          phone: d.phone ?? "", college: d.college ?? "",
          roll_number: d.roll_number ?? "", branch: d.branch ?? "",
          year: d.year ? String(d.year) : "", home_address: d.home_address ?? "",
        });
        if (d.college_id_path) setCollegeIdPath(d.college_id_path);
      }
    }).catch(() => {});
  }, [isEditMode]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>) => setForm(f => ({...f, [k]: e.target.value}));

  async function pickCollegeId(e: React.ChangeEvent<HTMLInputElement>) {
    setAiCheck(null);
    const f = e.target.files?.[0]; if (!f) return;
    if (!ALLOWED_TYPES.includes(f.type)) { setCollegeIdError("Only JPG, PNG, or WEBP allowed"); e.target.value=""; return; }
    if (f.size > 10*1024*1024) { setCollegeIdError("File too large. Max 10 MB"); e.target.value=""; return; }
    setCollegeIdError(""); setCollegeIdFile(f); setCollegeIdPath(""); setCollegeIdPreview(URL.createObjectURL(f));

    // Upload + analyze right away — the whole point is the student sees a
    // warning HERE, before they move on, not after they've already
    // finished registering.
    setAiChecking(true);
    try {
      const fd = new FormData(); fd.append("file", f);
      const r = await fetch("/api/uploads/college-id", { method: "POST", headers: { Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` }, body: fd });
      const j = await r.json();
      if (!j.success) { setCollegeIdError(j.error || "Upload failed — try again"); return; }
      setCollegeIdPath(j.data.storage_path);
      setAiCheck(j.data.ai_check ?? null);
    } catch {
      setCollegeIdError("Upload failed — check your connection and try again");
    } finally {
      setAiChecking(false);
    }
  }

  async function uploadCollegeId(): Promise<string> {
    // Upload already happened in pickCollegeId — this just returns the
    // result, or fails loudly if something went wrong before Continue.
    if (collegeIdPath) return collegeIdPath;
    throw new Error("College ID required");
  }

  // Applies the { token, batch, phone, profile_id, role, is_profile_complete }
  // shape returned by verify-otp — same fields /api/registration-tokens/start
  // used to return directly. Shared by confirmVerifyOtp below.
  function applyVerifiedBootstrap(data: any) {
    localStorage.setItem("sp_token", data.token);
    if (data.role && data.role !== "student") {
      router.replace(decideDestination({ role: data.role, is_profile_complete: !!data.is_profile_complete }));
      return;
    }
    const b = data.batch;
    const resolvedSlug = b?.slug ?? "";
    setBatch({ fee_amount: Number(b?.fee_amount)||0, slug: resolvedSlug, status: b?.status??"active", college: b?.college??"" });
    setBatchLoading(false);
    if (resolvedSlug) {
      localStorage.setItem("sp_batch_slug", resolvedSlug);
      sessionStorage.setItem("sp_batch_slug", resolvedSlug);
    }
    setForm(f => ({ ...f, phone: data.phone ?? f.phone, college: b?.college ?? f.college }));
    setStep("profile");
  }

  // Escapes a real trap, not just a copy fix: the installed app's own entry
  // points (HomeRedirect at "/", and /install itself) both prioritize
  // sp_pending_registration_token over everything else, including an
  // existing valid session — so once this token belongs to someone else's
  // registration (an old link, a shared/test device), EVERY navigation back
  // into the app bounces straight back to this exact screen with no way
  // out. Live-reported: a student/admin testing this got stuck here
  // indefinitely and read it as "the app won't let me in at all." Clearing
  // the stale token and sending them to /login (which has no such check)
  // is the only way out short of manually clearing browser storage, which
  // isn't realistic to expect from inside an installed PWA.
  //
  // Also clears sp_token/sp_role, not just the pending-registration token.
  // /login silently restores whatever session is already cached (by
  // design, for a returning user on their own device) — without this, "sign
  // in instead" on a shared/testing device would silently drop whoever taps
  // it into WHOEVER's session was last cached here, admin or otherwise,
  // with no re-authentication at all. Live-reported exactly this: tapping
  // the button logged the tapper straight in as the cached account. This
  // button's whole point is "let me sign in as myself" — it must force a
  // genuinely fresh sign-in, not silently reuse a stranger's session.
  function clearStaleLinkAndSignIn() {
    localStorage.removeItem("sp_pending_registration_token");
    localStorage.removeItem("sp_token");
    localStorage.removeItem("sp_role");
    router.push("/login");
  }

  async function requestVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setVerifyError("");
    setVerifyNotifGate("ok");
    // Notification gate: show the help first when notifications aren't on.
    // It never blocks sending — the server falls back to WhatsApp when
    // the app can't receive the code.
    // "native" (Capacitor shell) bypasses the browser gate — the app handles
    // its own notification permission there.
    if (!verifyGateAcked) {
      const gate = detectNotifState();
      if (gate !== "granted" && gate !== "native") {
        setVerifyNotifGate(gate);
        setVerifyGateAcked(true);
        return;
      }
    }
    setVerifyBusy(true);
    try {
      const regToken = searchParams.get("token") ?? "";
      // Local subscription: no session exists yet, so it is created on this
      // device and handed to the request instead of being saved server-side.
      const sub = await createLocalPushSubscription();
      const res = await fetch("/api/registration-tokens/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: regToken, phone: verifyPhone.trim(), subscription: sub ? sub.toJSON() : null }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Could not send verification code.");
      setVerifyViaWa(data.data?.channel === "whatsapp");
      setVerifySent(true);
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : "Could not send verification code.");
    } finally {
      setVerifyBusy(false);
    }
  }

  // Straight to the code box without asking for another code — used when
  // the person already has a code, so a new request would only hit the
  // 60-second cooldown.
  function openVerifyCodeEntry() {
    if (!verifyPhone.trim()) { setVerifyError("Enter your mobile number first."); return; }
    setVerifyError("");
    setVerifyNotifGate("ok");
    setVerifyOtp("");
    setVerifySent(true);
  }

  async function confirmVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setVerifyError("");
    setVerifyBusy(true);
    try {
      const regToken = searchParams.get("token") ?? "";
      const res = await fetch("/api/registration-tokens/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: regToken, phone: verifyPhone.trim(), otp: verifyOtp.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Invalid code.");
      applyVerifiedBootstrap(data.data);
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : "Invalid code.");
    } finally {
      setVerifyBusy(false);
    }
  }

  async function saveProfile() {
    setErrors({});
    const errs: Record<string,string> = {};
    if (!form.full_name.trim())    errs.full_name    = "Required";
    if (!form.father_name.trim()) errs.father_name = "Required";
    if (!form.gender) errs.gender = "Please select your gender";
    if (!form.phone.trim())        errs.phone        = "Required";
    else if (!/^[6-9]\d{9}$/.test(form.phone.trim())) errs.phone = "Enter a valid 10-digit number";
    if (!form.college)             errs.college      = "Required";
    if (!form.roll_number.trim())  errs.roll_number  = "Required";
    if (!form.branch)              errs.branch       = "Required";
    if (!form.year)                errs.year         = "Required";
    if (!form.home_address.trim()) errs.home_address = "Required";
    else if (form.home_address.trim().length < 10) errs.home_address = "Please enter your full address";
    if (!collegeIdFile && !collegeIdPath) errs.college_id = "College ID photo required";
    if (collegeIdError) errs.college_id = collegeIdError;
    if (aiChecking) errs.college_id = "Still analyzing your photo — one moment";
    // Hard block, no bypass, ONLY when the AI actually flagged a real
    // problem. A null aiCheck (the vision call itself couldn't run — both
    // Gemini and Groq unavailable, TODO #19) does NOT block — reverted
    // 2026-09-02 per explicit follow-up: don't block registration on an
    // infrastructure gap, just make sure the student sees a clear nudge
    // to double-check their photo against the reference example before
    // submitting. See the collegeIdPath && !aiCheck warning box below for
    // that nudge — informational only, never blocks Save & Continue.
    else if (aiCheck && !aiCheck.isIdCard) {
      errs.college_id = "This doesn't look like your College ID card. Upload a new photo that matches the reference example below.";
    } else if (aiCheck && aiCheck.isIdCard && !aiCheck.hasSignature) {
      errs.college_id = "We couldn't see a signature on this photo. Sign your name on a blank paper, place it next to your card, and photograph both together — then upload that photo.";
    }
    if (Object.keys(errs).length) {
      setErrors(errs);
      // Scroll to and focus the first invalid field, in the same top-to-bottom
      // order the fields appear on screen — not object key order, which is
      // not guaranteed to match visual order.
      const fieldOrder = ["full_name","father_name","gender","phone","college","roll_number","branch","year","home_address","college_id"];
      const firstInvalid = fieldOrder.find(k => errs[k]);
      if (firstInvalid) {
        requestAnimationFrame(() => {
          const wrapper = document.getElementById(`f-${firstInvalid}`);
          if (!wrapper) return;
          wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
          // College ID is a hidden <input type="file"> triggered by a
          // <label> — there's nothing meaningful to focus (calling .focus()
          // on a hidden file input doesn't open a keyboard or do anything
          // useful, and can look broken). Scroll only, per spec.
          if (firstInvalid === "college_id") return;
          // Find the actual focusable control inside the wrapper — the
          // wrapper div itself is not focusable, so focusing it silently
          // does nothing. A short delay lets the smooth scroll settle
          // before the keyboard opens, matching typical mobile form feel.
          setTimeout(() => {
            const control = wrapper.querySelector<HTMLElement>("input, select, textarea");
            control?.focus();
          }, 350);
        });
      }
      return;
    }
    setProfileSaving(true);
    try {
      const college_id_path = await uploadCollegeId();
      const batch_slug = localStorage.getItem("sp_batch_slug") ?? undefined;
      const r = await fetch("/api/profile",{method:"PATCH",headers:authH(),body:JSON.stringify({...form,college_id_path,...(batch_slug?{batch_slug}:{})})});
      const j = await r.json();
      if (!j.success) { setErrors(j.fields??{_:j.error??"Profile save failed"}); return; }
      setStep("payment");
      // Remember we've reached payment so a reload (e.g. returning from a UPI
      // app) restores this step instead of the registration form (P0-1).
      sessionStorage.setItem("sp_reg_step", "payment");
    } catch(e: any) { setErrors({_:e.message||"Something went wrong."}); }
    finally { setProfileSaving(false); }
  }

  // Navigates to the canonical payment page rather than calling any
  // gateway directly. /pay/[slug] is the one place responsible for knowing
  // which gateway is currently live (Razorpay today) and building its own
  // checkout order -- this page tried to own that decision across three
  // separate gateway swaps (PhonePe, then Cashfree, now Razorpay) and each
  // time it kept calling the RETIRED one, leaving a real student who
  // finished the form with an empty payment step and no way to pay. A plain
  // internal navigation cannot go stale the way a hardcoded gateway call can.
  const handlePayNow = useCallback(() => {
    if (!batch?.slug) return;
    setPgLoading(true);
    // Payment checkouts cannot run inside a nested frame: Cashfree's
    // checkout navigates the frame to its hosted page and PhonePe redirects
    // the frame to its hosted page, and both hosted pages refuse framing —
    // the frame then shows Chrome's broken-document icon instead of the
    // payment screen (same for Razorpay's UPI-app handoff). The admin
    // preview embeds this form in an iframe, and Telegram's web client does
    // too, so when this page is framed the Pay tap takes the whole
    // (top-level) window to /pay/[slug] instead of navigating inside the
    // frame. Standalone loads are unchanged.
    if (typeof window !== "undefined" && window.self !== window.top) {
      window.top!.location.href = `/pay/${encodeURIComponent(batch.slug)}`;
      return;
    }
    router.push(`/pay/${encodeURIComponent(batch.slug)}`);
  }, [batch, router]);

  const inp = "w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 transition-shadow";
  const canPay = batch && Number(batch.fee_amount) > 0;
  // Same condition the backend already enforces (batch.status !== "active")
  // on /api/cashfree/initiate and /api/payments/submit — checked here too so
  // the UI can hide payment options up front instead of the student only
  // finding out after tapping Pay and hitting a rejected request.
  const isActive = !batch || (batch.status ?? "active") === "active";

  /* ── Step 0: Confirm phone (WhatsApp entry links only) ─────────────────── */
  if (step === "verify") {
    return (
      <main style={{ minHeight: "100dvh", background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 420, background: ui.surface, borderRadius: 24, border: `1px solid ${ui.border}`, padding: 28, boxShadow: ui.shadow.card }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ width: 50, height: 50, borderRadius: ui.radius.tile, background: ui.textPrimary, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}><ShieldCheck size={24} strokeWidth={1.8} /></div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: ui.textPrimary }}>Confirm it&apos;s you</h1>
            <p style={{ margin: "8px 0 0", color: ui.textSecondary, fontSize: 14 }}>Enter the number you messaged the bot from</p>
          </div>

          {!verifySent ? (
            <form onSubmit={requestVerifyOtp}>
              <label style={{ display: "block", fontWeight: 600, fontSize: 14, color: ui.textPrimary, marginBottom: 8 }}>Mobile number</label>
              <input value={verifyPhone} onChange={e => { setVerifyPhone(e.target.value); setVerifyPhonePrefilled(false); }} inputMode="tel" autoComplete="tel" placeholder="10-digit mobile number" required style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "14px 15px", fontSize: 16, outline: "none" }} />
              {verifyPhonePrefilled && (
                <p style={{ margin: "6px 0 0", color: ui.textTertiary, fontSize: 12 }}>Filled in from the number you messaged the bot from — change it if this isn&apos;t right.</p>
              )}
              <button disabled={verifyBusy} style={{ width: "100%", marginTop: 16, border: 0, borderRadius: ui.radius.button, padding: "14px 16px", background: ui.textPrimary, color: "#fff", fontWeight: 600, fontSize: 15, opacity: verifyBusy ? .6 : 1, cursor: "pointer" }}>{verifyBusy ? "Sending…" : "Send code"}</button>
              <p style={{ margin: "12px 0 0", textAlign: "center", fontSize: 13, color: ui.textSecondary }}>
                Your code arrives as a notification on this device.
              </p>
              {verifyNotifGate === "prompt" && (
                <div style={{ marginTop: 12, padding: 14, borderRadius: ui.radius.button, background: ui.accentSoft, border: `1px solid ${ui.border}`, fontSize: 13, color: ui.textPrimary, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Turn on notifications</div>
                  Tap <b>Allow</b>, then send the code again.
                  <button type="button" onClick={async () => { try { await Notification.requestPermission(); } catch { /* denied */ } const g = detectNotifState(); setVerifyNotifGate(g === "granted" || g === "native" ? "ok" : g); }} style={{ width: "100%", marginTop: 10, border: 0, borderRadius: ui.radius.button, padding: "12px 16px", background: ui.textPrimary, color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>Turn on notifications</button>
              <button type="button" onClick={(e) => { setVerifyGateAcked(true); setVerifyNotifGate("ok"); requestVerifyOtp(e as unknown as React.FormEvent); }} style={{ width: "100%", marginTop: 8, border: 0, background: "transparent", color: ui.accent, fontWeight: 600, fontSize: 14, cursor: "pointer" }}>Send code another way</button>
                </div>
              )}
              {verifyNotifGate === "denied" && (
                <div style={{ marginTop: 12, padding: 14, borderRadius: ui.radius.button, background: ui.dangerSoft, border: `1px solid ${ui.border}`, fontSize: 13, color: ui.textPrimary, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Notifications are blocked</div>
                  Allow notifications for this site in your browser settings, then try again.
                </div>
              )}
              {verifyNotifGate === "unsupported" && (
                <div style={{ marginTop: 12, padding: 14, borderRadius: ui.radius.button, background: ui.canvas, border: `1px solid ${ui.border}`, fontSize: 13, color: ui.textSecondary, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, color: ui.textPrimary }}>Notifications aren&apos;t supported here</div>
                  Tap <b>Send code</b> again — it comes on WhatsApp. Or open your link in Chrome or the Student App.
                </div>
              )}
              <button type="button" onClick={openVerifyCodeEntry} style={{ width: "100%", marginTop: 10, border: 0, background: "transparent", color: ui.accent, fontWeight: 500, fontSize: 13, cursor: "pointer" }}>Already have a code? Enter it</button>
            </form>
          ) : (
            <form onSubmit={confirmVerifyOtp}>
              <div style={{ background: ui.accentSoft, borderRadius: ui.radius.button, padding: 14, marginBottom: 18, color: ui.accent, fontSize: 13 }}>{verifyViaWa ? "Code sent on WhatsApp." : "Code sent as a notification on this device."} Expires in 5 minutes.</div>
              <label style={{ display: "block", fontWeight: 600, fontSize: 14, color: ui.textPrimary, marginBottom: 8 }}>Verification code</label>
              <input value={verifyOtp} onChange={e => setVerifyOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6} required autoFocus style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "14px 15px", fontSize: 24, letterSpacing: 8, textAlign: "center" }} />
              <button disabled={verifyBusy || verifyOtp.length !== 6} style={{ width: "100%", marginTop: 16, border: 0, borderRadius: ui.radius.button, padding: "14px 16px", background: ui.textPrimary, color: "#fff", fontWeight: 600, fontSize: 15, opacity: verifyBusy || verifyOtp.length !== 6 ? .6 : 1, cursor: "pointer" }}>{verifyBusy ? "Verifying…" : "Continue"}</button>
              <button type="button" onClick={() => { setVerifySent(false); setVerifyOtp(""); setVerifyError(""); setVerifyNotifGate("ok"); setVerifyGateAcked(false); setVerifyViaWa(false); }} style={{ width: "100%", marginTop: 10, border: 0, background: "transparent", color: ui.accent, fontWeight: 500, cursor: "pointer" }}>Use another number</button>
            </form>
          )}

          {verifyError && <div style={{ marginTop: 16, padding: 12, borderRadius: ui.radius.button, background: ui.dangerSoft, color: ui.danger, fontSize: 13, fontWeight: 500 }}>{verifyError}</div>}
          {/* Same escape as the phone-mismatch case (item #133) — a token
              that's genuinely expired/consumed produces this exact wording
              from request-otp/verify-otp (registration-token.ts's
              validateRegistrationToken returns null for either reason, by
              design, so the two messages are the only two ways in). A
              student who already completed registration through a fresher
              link, but whose device still carries this stale
              sp_pending_registration_token, hits this every time they
              reopen the app with no way out otherwise — requestAppLoginOtp
              (app-login.ts) already handles both outcomes safely: an
              existing complete profile logs straight in, and a genuinely
              dead link with no profile/pending token honestly says "this
              number is not registered" instead of trapping them here. */}
          {(verifyError.startsWith("That number doesn't match this registration link") ||
            verifyError === "This registration link is no longer valid.") && (
            <button
              type="button"
              onClick={clearStaleLinkAndSignIn}
              style={{ width: "100%", marginTop: 10, border: 0, background: "transparent", color: ui.accent, fontWeight: 500, fontSize: 13, cursor: "pointer" }}
            >
              Not your link? Clear it and sign in instead
            </button>
          )}
          <p style={{ margin: "22px 0 0", textAlign: "center", color: ui.textTertiary, fontSize: 12 }}>Use the number you messaged the bot from.</p>
        </div>
      </main>
    );
  }

  /* ── Step 1: Profile ─────────────────────────────────────────────────── */
  if (step === "profile") {
    return (
      <main className="min-h-screen bg-gray-50 pb-10">
        <PageHeader
          title="Complete Profile"
          subtitle="Fill in your details to continue"
          backHref="/dashboard"
          rightSlot={
            <button
              onClick={() => setShowFAQ(true)}
              className="h-9 px-3.5 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs active:scale-95 transition-transform whitespace-nowrap"
              aria-label="FAQ"
            >
              FAQ
            </button>
          }
        />
        {showFAQ && <FAQModal onClose={() => setShowFAQ(false)} />}

        <div className="max-w-lg mx-auto px-4 mt-5 space-y-4">
          {/* If a stale token from a previously used account is cached on
              this device, the profile shown here may belong to the wrong
              account. Give people an escape hatch rather than a dead end. */}
          {errors._ && (
            <div className="bg-red-50 border border-red-200 text-red-600 text-sm p-3.5 rounded-2xl">{errors._}</div>
          )}

          {/* Step indicator */}
          <div className="mb-2">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-gray-900">Profile</span>
              <span className="text-xs text-gray-500">Step 1 of 2</span>
            </div>
            <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full w-1/2 rounded-full bg-gray-900" />
            </div>
          </div>

          {[
            { k:"full_name",   l:"Full Name",   ph:"As per college records", t:"text" },
            { k:"father_name", l:"Father Name", ph:"Father's full name",     t:"text" },
            { k:"gender",      l:"Gender",      ph:"",                         t:"select" },
            { k:"phone",       l:"Phone Number",ph:"10-digit mobile number",  t:"tel"  },
          ].map(f => (
            <div key={f.k} id={`f-${f.k}`} className="scroll-mt-24 scroll-mb-24">
              <label htmlFor={`rf-${f.k}`} className="text-sm font-semibold text-gray-700 block mb-1.5">{f.l}</label>
              {f.t === "select" ? (
                <select id={`rf-${f.k}`} className={inp} value={(form as any)[f.k]} onChange={set(f.k)}>
                  <option value="">Select gender</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              ) : (
                <input id={`rf-${f.k}`} type={f.t} className={inp} placeholder={f.ph} value={(form as any)[f.k]} onChange={set(f.k)} />
              )}
              {errors[f.k] && <p className="text-xs text-red-500 mt-1">{errors[f.k]}</p>}
            </div>
          ))}

          <div id="f-college" className="scroll-mt-24 scroll-mb-24">
            <label className="text-sm font-semibold text-gray-700 block mb-1.5">College</label>
            {batchLoading ? (
              <div className={`${inp} bg-gray-100 animate-pulse`} />
            ) : form.college ? (
              <div className={`${inp} bg-gray-50 text-gray-700 font-semibold flex items-center`}>
                {form.college}
              </div>
            ) : collegeRequestSent ? (
              <div className="rounded-2xl border border-green-200 bg-green-50 p-3.5">
                <p className="text-sm text-green-800 font-semibold">Request received</p>
                <p className="text-sm text-green-700 mt-1">
                  Thanks — we got your request for <b>{otherCollegeName}</b>. We&apos;ll add your college and message you on WhatsApp when it&apos;s ready, then you can finish signing up.
                </p>
              </div>
            ) : needsCollegePick ? (
              <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3.5">
                <p className="text-sm text-gray-700 font-medium mb-2">Which college are you from?</p>
                <select
                  aria-label="Select your college"
                  className={inp}
                  value={pickedCollege}
                  onChange={e => setPickedCollege(e.target.value)}
                  disabled={collegePickBusy}
                >
                  <option value="">Select your college</option>
                  {collegeOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  <option value="__other__">My college isn&apos;t listed</option>
                </select>
                {pickedCollege === "__other__" && (
                  <div className="mt-2.5">
                    <input
                      aria-label="Type your college name"
                      className={inp}
                      placeholder="Type your college name"
                      value={otherCollegeName}
                      onChange={e => setOtherCollegeName(e.target.value)}
                      disabled={collegeRequestBusy}
                    />
                    <p className="text-xs text-gray-500 mt-1.5">No problem — send us the name and we&apos;ll add your college. We&apos;ll message you on WhatsApp when it&apos;s ready.</p>
                  </div>
                )}
                {batchError && <p className="text-xs text-red-600 mt-2 whitespace-pre-line">{batchError}</p>}
                {pickedCollege === "__other__" ? (
                  <button
                    type="button"
                    onClick={requestCollege}
                    disabled={!otherCollegeName.trim() || collegeRequestBusy}
                    className="mt-2.5 w-full bg-blue-600 disabled:opacity-50 text-white text-sm font-bold rounded-xl py-2.5"
                  >
                    {collegeRequestBusy ? "Sending…" : "Request my college"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={pickCollege}
                    disabled={!pickedCollege || collegePickBusy}
                    className="mt-2.5 w-full bg-blue-600 disabled:opacity-50 text-white text-sm font-bold rounded-xl py-2.5"
                  >
                    {collegePickBusy ? "Checking…" : "Continue"}
                  </button>
                )}
              </div>
            ) : (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-3.5">
                <p className="text-sm text-red-600 font-medium">
                  {batchError || "Couldn't determine your college from your batch link."}
                </p>
                <p className="text-xs text-red-500 mt-1">
                  Try reopening the app from the same link/button your college shared with you. If this keeps happening, contact your batch admin.
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-2 text-xs font-semibold text-red-700 underline"
                >
                  Retry
                </button>
              </div>
            )}
            {!needsCollegePick && (
              <p className="text-xs text-gray-500 mt-1">Set automatically from your batch link — cannot be changed here.</p>
            )}
            {errors.college && <p className="text-xs text-red-500 mt-1">{errors.college}</p>}
          </div>

          <div id="f-roll_number" className="scroll-mt-24 scroll-mb-24">
            <label htmlFor="rf-roll_number" className="text-sm font-semibold text-gray-700 block mb-1.5">Roll Number</label>
            <input id="rf-roll_number" className={inp} placeholder="e.g. 21B01A0501" value={form.roll_number} onChange={set("roll_number")} />
            {errors.roll_number && <p className="text-xs text-red-500 mt-1">{errors.roll_number}</p>}
          </div>

          <div id="f-branch" className="scroll-mt-24 scroll-mb-24">
            <label htmlFor="rf-branch" className="text-sm font-semibold text-gray-700 block mb-1.5">Branch</label>
            <select id="rf-branch" className={inp} value={form.branch} onChange={set("branch")} disabled={!form.college}>
              <option value="">Select Branch</option>
              {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            {errors.branch && <p className="text-xs text-red-500 mt-1">{errors.branch}</p>}
          </div>

          <div id="f-year" className="scroll-mt-24 scroll-mb-24">
            <label htmlFor="rf-year" className="text-sm font-semibold text-gray-700 block mb-1.5">Passed Out Year</label>
            <select id="rf-year" className={inp} value={form.year} onChange={set("year")}>
              <option value="">Select Passed Out Year</option>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            {errors.year && <p className="text-xs text-red-500 mt-1">{errors.year}</p>}
          </div>

          <div id="f-home_address" className="scroll-mt-24 scroll-mb-24">
            <label htmlFor="rf-home_address" className="text-sm font-semibold text-gray-700 block mb-1.5">Home Address</label>
            <textarea id="rf-home_address" className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 resize-none" rows={3}
              placeholder="Door no., Street, City, District, State — PIN code"
              value={form.home_address} onChange={set("home_address")} />
            {errors.home_address && <p className="text-xs text-red-500 mt-1">{errors.home_address}</p>}
          </div>

          <div id="f-college_id" className="scroll-mt-24 scroll-mb-24">
            <label className="text-sm font-semibold text-gray-700 block mb-1.5">College ID Card</label>
            <p className="text-xs text-gray-500 mb-1.5">Your handwritten signature must be visible in the photo. If your card has no signature on it, sign your name on a blank paper, place it next to the card, and photograph both together.</p>
            <input type="file" accept={ACCEPT_ATTR} onChange={pickCollegeId} className="hidden" id="cid-upload" />
            <label htmlFor="cid-upload" data-tour="cid-upload"
              className={`flex items-center justify-center gap-3 w-full border-2 border-dashed rounded-2xl py-5 text-sm cursor-pointer transition-colors
                ${collegeIdError ? "border-red-300 bg-red-50 text-red-700" : collegeIdPreview ? "border-gray-400 bg-gray-50 text-gray-700" : "border-gray-200 text-gray-500"}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {collegeIdPreview ? "ID selected — tap to change" : "Tap to upload College ID"}
            </label>
            <p className="text-xs text-gray-500 mt-1">JPG, PNG, WEBP · Max 5 MB</p>
            {collegeIdPreview && <img src={collegeIdPreview} className="mt-2 w-full rounded-2xl max-h-48 object-cover" alt="College ID" />}
            {(errors.college_id || collegeIdError) && <p className="text-xs text-red-500 mt-1">{errors.college_id || collegeIdError}</p>}

            {aiChecking && (
              <p className="text-xs text-blue-500 mt-2 flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-blue-300 border-t-blue-500 rounded-full animate-spin inline-block" />
                Checking your photo for a visible ID and signature…
              </p>
            )}

            {collegeIdPath && !aiCheck && !aiChecking && (
              <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl p-3.5">
                <p className="text-sm font-semibold text-amber-800 flex items-center gap-1.5"><AlertTriangle size={14} strokeWidth={2} /> We couldn't automatically check this photo.</p>
                <p className="text-xs text-amber-700 mt-1">Please make sure it clearly matches the reference example below — your full College ID card with your signature visible — before continuing.</p>
              </div>
            )}

            {aiCheck && !aiChecking && (
              !aiCheck.isIdCard ? (
                <div className="mt-2 bg-red-50 border border-red-200 rounded-xl p-3.5">
                  <p className="text-sm font-semibold text-red-700 flex items-center gap-1.5"><AlertTriangle size={14} strokeWidth={2} /> This doesn't look like a College ID card.</p>
                  <p className="text-xs text-red-600 mt-1">{aiCheck.notes || "Please upload a clear photo of your actual College ID."}</p>
                  <label htmlFor="cid-upload" className="mt-2.5 inline-block text-xs font-semibold text-red-700 underline underline-offset-2 cursor-pointer">
                    Tap here to choose a different photo
                  </label>
                </div>
              ) : !aiCheck.hasSignature ? (
                <div className="mt-2 bg-red-50 border border-red-200 rounded-xl p-3.5">
                  <p className="text-sm font-semibold text-red-700 flex items-center gap-1.5"><AlertTriangle size={14} strokeWidth={2} /> We couldn't see a signature on this photo.</p>
                  <p className="text-xs text-red-600 mt-1">{aiCheck.notes || "Your signature must be visible in the photo. If your card has no signature on it, sign your name on a blank paper, place it next to the card, and photograph both together — then upload that photo."}</p>
                  <label htmlFor="cid-upload" className="mt-2.5 inline-block text-xs font-semibold text-red-700 underline underline-offset-2 cursor-pointer">
                    Tap here to choose a different photo
                  </label>
                </div>
              ) : (
                <p className="text-xs text-green-600 mt-2 flex items-center gap-1.5"><CheckCircle2 size={13} strokeWidth={2} /> Looks good — ID and signature both visible.</p>
              )
            )}

            {/* Reference example — fictional sample card (fake name, masked numbers), not a real student */}
            <div className="mt-3 rounded-2xl border border-gray-100 bg-gray-50 p-3">
              <p className="text-[11px] font-semibold text-gray-500 mb-2">Reference — how your photo should look</p>
              <img
                src="/register/college-id-reference.svg"
                alt="Sample College ID card showing correct framing — fictional student, for reference only"
                className="w-full max-w-[260px] mx-auto block rounded-lg"
              />
              <p className="text-[11px] text-gray-500 mt-2 text-center leading-relaxed">
                All four corners visible, good lighting, text fully readable — no blur or glare.
              </p>
              <p className="text-[11px] text-amber-700 font-medium mt-1.5 text-center leading-relaxed">
                Note: numbers are hidden in this sample only. Upload your own ID with all details fully visible — do not blur or mask anything.
              </p>
            </div>

            {/* Self-check checklist — student confirms visually before continuing */}
            <div className="mt-3 rounded-2xl border border-blue-100 bg-blue-50 p-3">
              <p className="text-[11px] font-semibold text-blue-700 mb-1.5">Before you continue, check your photo shows:</p>
              <ul className="text-[11px] text-blue-600 space-y-1 pl-4 list-disc">
                <li>Your college ID card, fully visible</li>
                <li>Your handwritten signature next to or below the ID</li>
                <li>Nothing blurry, cropped, or covered</li>
              </ul>
            </div>

          </div>


          {Object.keys(errors).some(k => k !== "_") && (
            <div className="bg-red-50 border border-red-200 text-red-600 text-sm font-semibold p-3.5 rounded-2xl text-center">
              {Object.keys(errors).filter(k => k !== "_").length === 1
                ? errors[Object.keys(errors).filter(k => k !== "_")[0]]
                : "Please correct the highlighted fields."}
            </div>
          )}

          <button onClick={saveProfile} disabled={profileSaving} data-tour="save-continue"
            className="w-full text-white py-4 rounded-xl font-bold disabled:opacity-60 text-base active:scale-[0.98] transition-transform bg-gray-900 hover:bg-gray-800">
            {profileSaving
              ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Saving...</span>
              : "Save & Continue →"
            }
          </button>
        </div>

        {!batchLoading && (
          <CoachMarkTour tourKey="register-profile" steps={[
            { selector: '[data-tour="cid-upload"]', title: "Upload your College ID", text: "Tap here to add a photo of your College ID with your signature visible. It's checked automatically before you can continue." },
            { selector: '[data-tour="save-continue"]', title: "Save & Continue", text: "Once your details and ID look good, tap here to move on to payment." },
          ]} />
        )}
      </main>
    );
  }

  /* ── Step 2: Payment ─────────────────────────────────────────────────── */
  return (
    <main className="min-h-screen bg-gray-50 pb-10">
      <PageHeader
        title="Fee Payment"
        subtitle="Step 2 of 2"
        onBack={() => setStep("profile")}
        rightSlot={
          <button
            onClick={() => setShowFAQ(true)}
            className="h-9 px-3.5 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs active:scale-95 transition-transform whitespace-nowrap"
            aria-label="FAQ"
          >
            FAQ
          </button>
        }
      />
      {showFAQ && <FAQModal onClose={() => setShowFAQ(false)} />}

      {/* Step indicator */}
      <div className="mx-4 mt-5 mb-5 max-w-lg md:mx-auto">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-gray-900">Payment</span>
          <span className="text-xs text-gray-500">Step 2 of 2</span>
        </div>
        <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full w-full rounded-full bg-gray-900" />
        </div>
      </div>

      {batchLoading && (
        <div className="mx-4 space-y-3">
          <div className="h-28 bg-white rounded-2xl animate-pulse" />
          <div className="h-52 bg-white rounded-2xl animate-pulse" />
        </div>
      )}

      {batchError && !batch && (
        <div className="mx-4 bg-red-50 border border-red-200 rounded-2xl p-5 text-center">
          <p className="text-sm text-red-600 mb-3">{batchError}</p>
          <button onClick={() => window.location.reload()} className="text-sm font-semibold text-gray-900">Retry</button>
        </div>
      )}

      {batch && (
        <>
          {/* Amount card */}
          <div className="mx-4 bg-white rounded-2xl shadow-sm overflow-hidden">
            <div className="px-5 py-5 border-b border-gray-50">
              <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-0.5">Total Amount</p>
              <p className="text-3xl font-semibold text-gray-900">
                {canPay ? `₹${batch.fee_amount.toLocaleString("en-IN")}` : "To be announced"}
              </p>
            </div>
          </div>

          {canPay && (
            <p className="mx-4 mt-2.5 text-[11px] text-gray-500 text-center leading-relaxed">
              By proceeding you agree to our{" "}
              <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline text-gray-500">Terms & Conditions</a>,{" "}
              <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline text-gray-500">Privacy Policy</a> and{" "}
              <a href="/refund-policy" target="_blank" rel="noopener noreferrer" className="underline text-gray-500">Refund Policy</a>.
            </p>
          )}

          {/* Batch not accepting payments — show only this, no Pay button */}
          {!isActive && (
            <div className="mx-4 mt-4 bg-amber-50 border border-amber-200 rounded-2xl p-5 text-center">
              <p className="text-sm font-semibold text-amber-800">
                Payments are currently disabled for this batch. Please wait until the administrator opens registrations.
              </p>
            </div>
          )}

          {/* Active batch, but the fee hasn't been set yet (e.g. a batch just
              opened via End Batch). Registration is saved; payment opens once
              the admin configures the fee. Without this the student would see
              a bare "₹0" and no way forward. */}
          {isActive && !canPay && (
            <div className="mx-4 mt-4 bg-blue-50 border border-blue-200 rounded-2xl p-5 text-center">
              <p className="text-sm font-semibold text-blue-800">
                Your registration details are saved. The fee for this batch is being finalised — you'll be able to complete your payment here shortly.
              </p>
            </div>
          )}

          {isActive && canPay && (
            <div className="mx-4 mt-4 space-y-4">
              {/* ── Pay: always shown when a fee is set. No longer gated on
                  "is the gateway ready" -- see handlePayNow's comment for why
                  that flag kept pointing at a retired gateway. */}
              <div>
                <button onClick={handlePayNow} disabled={pgLoading} data-tour="pay-now-gateway"
                  className="w-full bg-gray-900 hover:bg-gray-800 text-white py-4 rounded-2xl font-bold text-base active:scale-[0.98] transition-transform disabled:opacity-60">
                  {pgLoading
                    ? <span className="flex items-center justify-center gap-2"><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Opening…</span>
                    : `Pay ₹${Number(batch.fee_amount).toLocaleString("en-IN")} now`
                  }
                </button>
                <p className="text-xs text-gray-500 text-center mt-2">Confirmed instantly · Registration continues right away</p>
              </div>
            </div>
          )}

          {isActive && canPay && (
            <CoachMarkTour tourKey="register-payment" steps={[
              { selector: '[data-tour="pay-now-gateway"]', title: "Pay instantly", text: "Fastest way to pay — confirmed right away, no screenshot needed." },
            ]} />
          )}
        </>
      )}
    </main>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}><RegisterPageInner /></Suspense>
  );
}
