"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { ui } from "@/lib/student-ui";

// Sign-up — the new-student path.
//
// One clean path: name + phone + college.
//  - College IS listed: we start registration for that college's batch
//    (or join the waiting list if no batch is open yet).
//  - College is NOT listed: the student is never blocked. They type the
//    college name and send it as a request — the admin is notified and the
//    student gets a confirmation, not a dead end.
//
// The full profile + payment still happens on /register (the existing flow);
// this page only gets the student to the right place.
const OTHER_COLLEGE = "__other__";

type DoneState =
  | { kind: "waitlisted"; collegeName: string; position: number | null }
  | { kind: "college_requested"; collegeName: string; name: string }
  | null;

export default function SignUpPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [colleges, setColleges] = useState<{ id: string; name: string }[]>([]);
  const [collegesLoading, setCollegesLoading] = useState(true);
  const [pickedCollege, setPickedCollege] = useState("");
  const [otherCollegeName, setOtherCollegeName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<DoneState>(null);

  useEffect(() => {
    fetch("/api/settings/colleges", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.success && Array.isArray(j.data)) setColleges(j.data);
      })
      .catch(() => {})
      .finally(() => setCollegesLoading(false));
  }, []);

  const isOther = pickedCollege === OTHER_COLLEGE;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const cleanName = name.trim();
    const cleanPhone = phone.replace(/\D/g, "").slice(-10);
    if (cleanName.length < 2) {
      setError("Please enter your full name.");
      return;
    }
    if (cleanPhone.length !== 10) {
      setError("Please enter a valid 10-digit mobile number.");
      return;
    }
    if (!pickedCollege) {
      setError("Please pick your college.");
      return;
    }

    // Unlisted college — send it as a request, never a dead end.
    if (isOther) {
      const collegeName = otherCollegeName.trim();
      if (collegeName.length < 2) {
        setError("Please type your college name.");
        return;
      }
      setBusy(true);
      try {
        const res = await fetch("/api/college-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: cleanName, phone: cleanPhone, college_name: collegeName }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
          throw new Error(data?.error ?? "Could not send your request. Please try again.");
        }
        setDone({ kind: "college_requested", collegeName, name: cleanName });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not send your request. Please try again.");
      } finally {
        setBusy(false);
      }
      return;
    }

    // Listed college — start registration for its batch (or the waiting list).
    setBusy(true);
    try {
      const res = await fetch("/api/signup/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleanName, phone: cleanPhone, college: pickedCollege }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error ?? "Could not start sign-up. Please try again.");
      }
      if (data.data?.action === "register" && data.data?.url) {
        // Remember the name so /register can prefill it — the student
        // should not have to type it twice.
        try {
          window.sessionStorage.setItem("sp_signup_name", cleanName);
        } catch {}
        router.replace(data.data.url);
        return;
      }
      if (data.data?.action === "waitlisted") {
        const collegeName = colleges.find((c) => c.id === pickedCollege)?.name ?? pickedCollege;
        setDone({ kind: "waitlisted", collegeName, position: data.data.position ?? null });
        return;
      }
      throw new Error("Could not start sign-up. Please try again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start sign-up. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Confirmation screens — the student always gets a next step, never a dead end.
  if (done?.kind === "waitlisted") {
    return (
      <main style={{ minHeight: "100dvh", background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 440, background: ui.surface, borderRadius: 24, border: `1px solid ${ui.border}`, padding: "42px 34px", boxShadow: ui.shadow.card, textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 600, color: ui.textPrimary, marginBottom: 10 }}>You&apos;re on the waiting list</div>
          <p style={{ color: ui.textSecondary, fontSize: 14, lineHeight: 1.6, margin: "0 0 8px" }}>
            Registration for {done.collegeName} is paused right now.
            {done.position ? ` You are number ${done.position} in line.` : ""} We&apos;ll message you on WhatsApp as soon as the next batch opens — no need to check back here.
          </p>
          <Link href="/welcome" style={{ display: "inline-block", marginTop: 18, color: ui.accent, fontWeight: 600, fontSize: 14, textDecoration: "none" }}>Back to Sign in / Sign up</Link>
        </div>
      </main>
    );
  }

  if (done?.kind === "college_requested") {
    return (
      <main style={{ minHeight: "100dvh", background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ width: "100%", maxWidth: 440, background: ui.surface, borderRadius: 24, border: `1px solid ${ui.border}`, padding: "42px 34px", boxShadow: ui.shadow.card, textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 600, color: ui.textPrimary, marginBottom: 10 }}>Request received</div>
          <p style={{ color: ui.textSecondary, fontSize: 14, lineHeight: 1.6, margin: "0 0 8px" }}>
            Thanks, {done.name}. We got your request for <b style={{ color: ui.textPrimary }}>{done.collegeName}</b>. We&apos;ll add your college and message you on WhatsApp when it&apos;s ready — then you can finish signing up.
          </p>
          <Link href="/welcome" style={{ display: "inline-block", marginTop: 18, color: ui.accent, fontWeight: 600, fontSize: 14, textDecoration: "none" }}>Back to Sign in / Sign up</Link>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: "100dvh", background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440, background: ui.surface, borderRadius: 24, border: `1px solid ${ui.border}`, padding: "42px 34px", boxShadow: ui.shadow.card }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 50, height: 50, borderRadius: ui.radius.tile, background: ui.textPrimary, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
            <GraduationCap size={24} strokeWidth={1.8} />
          </div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-.03em", color: ui.textPrimary }}>Sign up</h1>
          <p style={{ margin: "8px 0 0", color: ui.textSecondary, fontSize: 14 }}>Create your Student Platform account.</p>
        </div>

        <form onSubmit={submit}>
          <label style={{ display: "block", fontWeight: 600, fontSize: 14, color: ui.textPrimary, marginBottom: 8 }}>Your full name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sai Krupal"
            required
            style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "14px 15px", fontSize: 16, outline: "none", marginBottom: 16 }}
          />

          <label style={{ display: "block", fontWeight: 600, fontSize: 14, color: ui.textPrimary, marginBottom: 8 }}>Mobile number</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            autoComplete="off"
            placeholder="10-digit mobile number"
            required
            style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "14px 15px", fontSize: 16, outline: "none", marginBottom: 16 }}
          />

          <label style={{ display: "block", fontWeight: 600, fontSize: 14, color: ui.textPrimary, marginBottom: 8 }}>Your college</label>
          <select
            value={pickedCollege}
            onChange={(e) => setPickedCollege(e.target.value)}
            disabled={collegesLoading}
            required
            style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "14px 15px", fontSize: 16, outline: "none", background: "#fff", marginBottom: 16 }}
          >
            <option value="">{collegesLoading ? "Loading colleges…" : "Select your college"}</option>
            {colleges.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
            <option value={OTHER_COLLEGE}>My college isn&apos;t listed</option>
          </select>

          {isOther && (
            <div style={{ background: ui.accentSoft, borderRadius: ui.radius.button, padding: 14, marginBottom: 16 }}>
              <label style={{ display: "block", fontWeight: 600, fontSize: 14, color: ui.textPrimary, marginBottom: 8 }}>Type your college name</label>
              <input
                value={otherCollegeName}
                onChange={(e) => setOtherCollegeName(e.target.value)}
                placeholder="e.g. ABC Engineering College, Hyderabad"
                style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "14px 15px", fontSize: 16, outline: "none", background: "#fff" }}
              />
              <p style={{ margin: "10px 0 0", fontSize: 13, color: ui.textSecondary, lineHeight: 1.5 }}>
                No problem — send us the name and we&apos;ll add your college. We&apos;ll message you on WhatsApp when it&apos;s ready.
              </p>
            </div>
          )}

          <button
            disabled={busy}
            style={{ width: "100%", border: 0, borderRadius: ui.radius.button, padding: "14px 16px", background: ui.textPrimary, color: "#fff", fontWeight: 600, fontSize: 15, opacity: busy ? 0.6 : 1, cursor: "pointer" }}
          >
            {busy ? "Please wait…" : isOther ? "Request my college" : "Continue"}
          </button>

          {error && (
            <div style={{ marginTop: 16, padding: 12, borderRadius: ui.radius.button, background: ui.dangerSoft, color: ui.danger, fontSize: 13, fontWeight: 500 }}>{error}</div>
          )}

          <p style={{ margin: "16px 0 0", textAlign: "center", fontSize: 13, color: ui.textSecondary }}>
            Already have an account?{" "}
            <Link href="/login" style={{ color: ui.accent, fontWeight: 500, textDecoration: "none" }}>Sign in</Link>
          </p>
        </form>
      </div>
    </main>
  );
}
