"use client";

import { FormEvent, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { decideDestination } from "@/lib/route-decision";
import { GraduationCap } from "lucide-react";
import { ui } from "@/lib/student-ui";
import DiagnosePanel from "@/components/DiagnosePanel";
import { getThisDeviceEndpoint, createLocalPushSubscription, refreshPushSubscription, syncPushSubscription, requestAndSubscribeToPush } from "@/lib/push/subscribe-client";

// The green "continue on WhatsApp" button — the login screen's ONE
// fallback. There is only one path to the code: the notification (read it,
// type it in by hand), or this button. No other WhatsApp links on this screen.
const waLinkButton: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "center", marginTop: 12,
  textAlign: "center", textDecoration: "none", border: 0, borderRadius: ui.radius.button,
  padding: "14px 16px", background: "#25D366", color: "#fff", fontWeight: 600, fontSize: 15,
};

export default function AppLoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  // True only while the send request is in flight (the banner shows
  // "Sending your code…" then). Separate from `busy`, which also covers
  // verification.
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState("");
  // The one fallback, on the same screen: opens WhatsApp with VERIFY
  // pre-filled. Sending it reopens the 24-hour WhatsApp window, so the
  // bot can reply with the 6-digit login code to type in the box below.
  const [waLink, setWaLink] = useState<string | null>(null);
  // True once a send failed or timed out — the code did not arrive as a
  // notification, so the screen points at the WhatsApp button instead.
  const [sendFailed, setSendFailed] = useState(false);
  // "Turn on notifications" on the code screen (14 Nov 2026): the code
  // can only arrive automatically when this phone has a push
  // subscription, and the browser only lets us ask for permission from
  // a real tap. Staff phones never see the NotificationGate's ask, so
  // without this button a phone with notifications off can never heal.
  const [notifOn, setNotifOn] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifDenied, setNotifDenied] = useState(false);
  // "Not registered" state: the number has no profile, so the student needs
  // a registration start on WhatsApp (registration starts only via the bot).
  // Set from the server's structured notRegistered flag, never by matching
  // the error wording.
  const [registerLink, setRegisterLink] = useState<string | null>(null);
  const [notRegistered, setNotRegistered] = useState(false);
  // "App not working?" self-diagnose panel (14 Nov 2026): the student taps
  // it, it checks their account + phone and offers the one fix — or files
  // the report itself. One visible entry on this screen, not a hidden link.
  const [showDiagnose, setShowDiagnose] = useState(false);

  // Typed OTP only (Krupal, 9 Nov 2026): the code is NEVER auto-filled and
  // NEVER auto-submitted. The service worker still shows the code in the
  // notification and hands it to this page (see public/sw.js), but this
  // page deliberately ignores it — the student reads the notification (or
  // the WhatsApp message) and types the 6 digits into the box, then taps
  // Login. That is the whole point: knowing a number must never be enough
  // to sign in as someone else.
  // The one thing this effect still does: if a notification tap opened a
  // fresh window with the code in the URL fragment (/login#otp=...), strip
  // the fragment so the code does not sit in the address bar or history.
  // The code itself is discarded — never filled in, never submitted.
  useEffect(() => {
    if (/otp=\d{6}/.test(window.location.hash)) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    fetch("/api/auth/whatsapp-verify-link")
      .then(r => r.json())
      .then(d => { if (d?.success && d.data?.waLink) setWaLink(d.data.waLink); })
      .catch(() => {});
    fetch("/api/auth/whatsapp-register-link")
      .then(r => r.json())
      .then(d => { if (d?.success && d.data?.waLink) setRegisterLink(d.data.waLink); })
      .catch(() => {});
  }, []);


  useEffect(() => {
    let cancelled = false;
    // Set once the restore has resolved one way or the other. The hard
    // fallback below only fires while this is false.
    let done = false;
    // Set when the session turns out valid, before the client-side
    // navigation starts — if that navigation itself stalls, the hard
    // fallback still gets the student into the app with a hard navigation.
    let destination: string | null = null;
    const token = window.localStorage.getItem("sp_token");
    const headers: HeadersInit = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    const controller = new AbortController();
    // First line of defence (2026-10-19 fix): abort a hung session request
    // after 8s. On its own it is not enough: the abort timer was cleared as
    // soon as response headers arrived, so a stalled response body — res.json()
    // never resolving — still left "Restoring your session…" up forever.
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    // Hard fallback: no matter what the check does — slow fetch, stalled
    // body, hung JSON parse, stalled client-side navigation — after 8s the
    // student is never left on "Please wait": a valid session hard-navigates
    // into the app, anything else shows the normal login form.
    const hardFallback = window.setTimeout(() => {
      if (done || cancelled) return;
      done = true;
      controller.abort();
      if (destination) window.location.replace(destination);
      else setRestoring(false);
    }, 8000);
    const settle = () => {
      done = true;
      window.clearTimeout(timeout);
      window.clearTimeout(hardFallback);
    };

    (async () => {
      try {
        const res = await fetch("/api/auth/session", {
          cache: "no-store",
          headers,
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (res.status === 401 || res.status === 403 || (res.ok && !data?.success)) throw new Error("SESSION_INVALID");
        if (!res.ok) throw new Error("SESSION_TRANSIENT");
        if (cancelled) return;
        destination = decideDestination(data.data);
        window.localStorage.setItem("sp_role", data.data.role);
        router.replace(destination);
        // Deliberately do NOT settle here: if the client-side navigation
        // stalls, the hard fallback above still hard-navigates to the app.
      } catch (e) {
        if (cancelled) return;
        settle();
        // A timeout/network error is transient; do not erase a valid stored
        // login just because the server is slow.
        if ((e as Error)?.message === "SESSION_TRANSIENT" || (e as Error)?.name === "AbortError" || e instanceof TypeError) { setRestoring(false); return; }
        // A 401 here does NOT prove the stored token is dead: /api/auth/session
        // answers 401 for any getSession miss, including a transient database
        // or server error. Deleting the token on one 401 permanently signed
        // the user out even though the session row in the database was still
        // valid (seen live 9 Nov 2026 — the owner had a live session row and
        // still landed on this form). So the token is KEPT: the form shows,
        // and a fresh code login overwrites it. A truly dead token just 401s
        // again on the next open and shows the form — no harm.
        setRestoring(false);
      }
    })();

    return () => { cancelled = true; window.clearTimeout(timeout); window.clearTimeout(hardFallback); controller.abort(); };
  }, [router]);

  function switchAccount() {
    window.localStorage.removeItem("sp_token");
    window.localStorage.removeItem("sp_role");
    setRestoring(false);
    setSent(false);
    setSending(false);
    setOtp("");
    setError("");
    setPhone("");
    setSendFailed(false);
    setNotifOn(false);
    setNotifDenied(false);
    setNotRegistered(false);
  }

  // ONE path to the code: enter the number, tap the button, the code
  // arrives as a notification and the student types it in. There is no
  // notification gate, no hidden "already have a code" link, no separate
  // "try again" route — if the code does not arrive, the same screen
  // already shows the code box and the one WhatsApp button.
  //
  // The code screen appears the moment the button is tapped, not when the
  // server answers: on a slow phone network the request itself can take
  // the whole 15 seconds, and the student must never stare at a stuck
  // button with nowhere to go. The WhatsApp button is usable from the
  // tap — the bot replies with a code to type in the box below.
  async function requestOtp(e: FormEvent) {
    e.preventDefault();
    const number = phone.trim();
    if (!number) { setError("Enter your mobile number first."); return; }
    setError("");
    setSendFailed(false);
    setNotRegistered(false);
    setOtp("");
    // Show the code screen now — see the comment above.
    setSent(true);
    window.sessionStorage.setItem("sp_login_phone", number);
    setBusy(true);
    setSending(true);
    // The send must never stick on "Sending…" forever: abort after 30s.
    // The server can take up to ~20s when push is slow (a 10s send to
    // this device plus a 10s send to any linked device), so a 15s client
    // timeout fired while the server was still sending — the page then
    // said "didn't arrive" even though the code was on its way (seen live
    // 9 Nov 2026). The WhatsApp button is already on screen when it fires.
    const controller = new AbortController();
    const sendTimeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const deviceEndpoint = await getThisDeviceEndpoint();
      const res = await fetch("/api/auth/app-login/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: number, device_endpoint: deviceEndpoint }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        // Structured flag from the server — the number has no profile, so
        // offer a registration start instead of a dead end. Back to the
        // number screen: there is no code coming for this number.
        if (data?.notRegistered === true) {
          setNotRegistered(true);
          setSent(false);
          throw new Error(data.error ?? "This mobile number is not registered.");
        }
        // The server flags "no channel could deliver" — the code did not
        // go out as a notification. A flag, not the wording of the
        // message: matching the wording is what left this button dead.
        // The calm banner above (sendFailed) is the WHOLE message here:
        // the red error box below must NOT also show, or the student sees
        // a red error first even though the fallback is working. So
        // return, don't throw. The WhatsApp button below is now the one
        // next step, and the phone's push subscription is refreshed in
        // the background so the next login can arrive by push (a VAPID
        // rotation leaves the old subscription permanently dead — see
        // refreshPushSubscription).
        if (data?.fallback === "whatsapp_code") {
          setSendFailed(true);
          void refreshPushSubscription().catch(() => {});
          return;
        }
        throw new Error(data?.error ?? "Could not send login code.");
      }
      // Code issued — it arrives as a notification; the student types it
      // in (typed OTP only, no auto-fill).
      setSendFailed(false);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        // The request was still in flight when the client gave up — the
        // server may have issued and sent the code anyway (a slow push
        // send does not stop FCM delivering it). Do NOT show "didn't
        // arrive": that banner was wrong live on 9 Nov 2026, when the code
        // was sitting in the notification shade. Leave the code box up
        // with its normal "Code sent" text so the code can be typed when
        // it lands; the WhatsApp button below is the fallback if it never
        // comes. No red box.
        void refreshPushSubscription().catch(() => {});
      } else {
        setError(e instanceof Error ? e.message : "Could not send login code.");
      }
    } finally {
      window.clearTimeout(sendTimeout);
      setSending(false);
      setBusy(false);
    }
  }

  async function enableNotifications() {
    setNotifBusy(true);
    try {
      const { granted } = await requestAndSubscribeToPush();
      if (granted) setNotifOn(true);
      else setNotifDenied(true);
    } catch {
      // The save can fail before login (no session yet) even when the
      // subscription itself was created — the post-login sync links it
      // then. Permission granted is what matters here.
      if (typeof Notification !== "undefined" && Notification.permission === "granted") setNotifOn(true);
      else if (typeof Notification !== "undefined" && Notification.permission === "denied") setNotifDenied(true);
    } finally {
      setNotifBusy(false);
    }
  }

  async function verifyOtp(e: FormEvent) {
    e.preventDefault();
    await submitOtp(phone.trim(), otp.trim());
  }

  async function submitOtp(forPhone: string, code: string) {
    setError("");
    setBusy(true);
    // Same 15s bound as the send: verification must never stick forever.
    const controller = new AbortController();
    const verifyTimeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch("/api/auth/app-login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: forPhone, otp: code }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Invalid login code.");

      window.localStorage.setItem("sp_token", data.data.token);
      window.localStorage.setItem("sp_role", data.data.role);
      window.sessionStorage.removeItem("sp_login_phone");
      // Link this phone for future push logins, now that a session exists:
      // after a VAPID rotation the stored subscription is dead, so the
      // fresh one made on this screen is saved against the account — the
      // next login arrives as a notification. Best effort; the login
      // already succeeded, so this never blocks the navigation.
      void (async () => {
        try {
          const sub = await createLocalPushSubscription();
          if (sub) await syncPushSubscription(sub);
        } catch { /* push linking is best effort */ }
      })();
      router.replace(decideDestination(data.data));
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("Verification timed out — please try again.");
      } else {
        setError(e instanceof Error ? e.message : "Invalid login code.");
      }
    } finally {
      window.clearTimeout(verifyTimeout);
      setBusy(false);
    }
  }

  if (restoring) {
    return (
      <main style={{ minHeight: "100dvh", background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <div style={{ textAlign: "center", color: ui.textSecondary, width: "100%", maxWidth: 360 }}>
          <div style={{ width: 48, height: 48, borderRadius: ui.radius.tile, background: ui.textPrimary, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}><GraduationCap size={21} strokeWidth={1.8} /></div>
          <div style={{ fontWeight: 600, color: ui.textPrimary }}>Restoring your session…</div>
          <div style={{ fontSize: 12, marginTop: 5 }}>Please wait</div>
          <button type="button" onClick={switchAccount} style={{ marginTop: 20, border: 0, background: "transparent", color: ui.accent, fontWeight: 500, fontSize: 14, padding: "8px 12px", cursor: "pointer" }}>Use another account</button>
        </div>
      </main>
    );
  }


  return (
    <main style={{ minHeight: "100dvh", background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 440, background: ui.surface, borderRadius: 24, border: `1px solid ${ui.border}`, padding: "42px 34px", boxShadow: ui.shadow.card }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 50, height: 50, borderRadius: ui.radius.tile, background: ui.textPrimary, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}><GraduationCap size={24} strokeWidth={1.8} /></div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600, letterSpacing: "-.03em", color: ui.textPrimary }}>Student Platform</h1>
          <p style={{ margin: "8px 0 0", color: ui.textSecondary, fontSize: 14 }}>Your student account, in one place.</p>
        </div>

        {!sent ? (
          <form onSubmit={requestOtp}>
            <label style={{ display: "block", fontWeight: 600, fontSize: 14, color: ui.textPrimary, marginBottom: 8 }}>Registered mobile number</label>
            <input name="student-login-mobile" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" autoComplete="off" autoCorrect="off" spellCheck={false} placeholder="10-digit mobile number" required style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "14px 15px", fontSize: 16, outline: "none" }} />
            <button disabled={busy} style={{ width: "100%", marginTop: 16, border: 0, borderRadius: ui.radius.button, padding: "14px 16px", background: ui.textPrimary, color: "#fff", fontWeight: 600, fontSize: 15, opacity: busy ? .6 : 1, cursor: "pointer" }}>{busy ? "Sending…" : "Send login code"}</button>
            <p style={{ margin: "12px 0 0", textAlign: "center", fontSize: 13, color: ui.textSecondary }}>
              Your code arrives as a notification — read it and type the 6 digits below.
            </p>
            {!notRegistered && registerLink && (
              <a href={registerLink} target="_blank" rel="noopener noreferrer" style={{ display: "block", marginTop: 14, textAlign: "center", color: ui.accent, fontSize: 13, fontWeight: 500, textDecoration: "none" }}>New student? Sign up on WhatsApp</a>
            )}
            {!notRegistered && !registerLink && (
              <div style={{ marginTop: 14, textAlign: "center", fontSize: 13, color: ui.textSecondary }}>New student? Message the WhatsApp bot and reply <b>Register</b>.</div>
            )}
          </form>
        ) : (
          <form onSubmit={verifyOtp}>
            <div style={{ background: ui.accentSoft, borderRadius: ui.radius.button, padding: 14, marginBottom: 18, color: ui.accent, fontSize: 13 }}>
              {sending
                ? "Sending your code…"
                : sendFailed
                  ? "The code didn't arrive as a notification. Tap the green button below — WhatsApp sends the code, type it here."
                  : "Code sent as a notification — read it and type the 6 digits here. Expires in 5 minutes."}
            </div>
            <label style={{ display: "block", fontWeight: 600, fontSize: 14, color: ui.textPrimary, marginBottom: 8 }}>Login code</label>
            <input value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={6} required autoFocus style={{ width: "100%", boxSizing: "border-box", border: `1px solid ${ui.borderStrong}`, borderRadius: ui.radius.button, padding: "14px 15px", fontSize: 24, letterSpacing: 8, textAlign: "center" }} />
            <button disabled={busy || otp.length !== 6} style={{ width: "100%", marginTop: 16, border: 0, borderRadius: ui.radius.button, padding: "14px 16px", background: ui.textPrimary, color: "#fff", fontWeight: 600, fontSize: 15, opacity: busy || otp.length !== 6 ? .6 : 1, cursor: "pointer" }}>{busy ? "Verifying…" : "Login"}</button>
            {waLink && (
              <a href={waLink} target="_blank" rel="noopener noreferrer" style={waLinkButton}>
                Get code on WhatsApp
              </a>
            )}
            {sendFailed && !notifOn && (
              <button type="button" onClick={() => void enableNotifications()} disabled={notifBusy} style={{ width: "100%", marginTop: 10, border: `1px solid ${ui.borderStrong}`, background: "transparent", borderRadius: ui.radius.button, padding: "14px 16px", color: ui.textPrimary, fontWeight: 600, fontSize: 15, opacity: notifBusy ? .6 : 1, cursor: "pointer" }}>
                {notifBusy ? "Turning on…" : "Turn on notifications"}
              </button>
            )}
            {sendFailed && notifOn && (
              <p style={{ margin: "12px 0 0", textAlign: "center", fontSize: 13, color: ui.textSecondary }}>
                Notifications on — next time the code will arrive automatically. For this login, use WhatsApp above.
              </p>
            )}
            {sendFailed && notifDenied && !notifOn && (
              <p style={{ margin: "12px 0 0", textAlign: "center", fontSize: 13, color: ui.textSecondary }}>
                Notifications are off for this site — tap the lock icon by the address bar, allow Notifications, then tap the button again.
              </p>
            )}
            <button type="button" onClick={switchAccount} style={{ width: "100%", marginTop: 10, border: 0, background: "transparent", color: ui.accent, fontWeight: 500, cursor: "pointer" }}>Use another number</button>
          </form>
        )}

        {error && <div style={{ marginTop: 16, padding: 12, borderRadius: ui.radius.button, background: ui.dangerSoft, color: ui.danger, fontSize: 13, fontWeight: 500 }}>{error}</div>}
        {notRegistered && (
          <div style={{ marginTop: 12, padding: 14, borderRadius: ui.radius.button, background: ui.accentSoft, border: `1px solid ${ui.border}`, fontSize: 13, color: ui.textPrimary, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>You have not registered yet</div>
            Registration starts on WhatsApp — tap below and reply <b>Register</b> to the bot to get your registration link.
            {registerLink ? (
              <a href={registerLink} target="_blank" rel="noopener noreferrer" style={waLinkButton}>Register on WhatsApp</a>
            ) : (
              <div style={{ marginTop: 8 }}>Message the Student Platform WhatsApp bot and reply <b>Register</b> to get started.</div>
            )}
          </div>
        )}
        {showDiagnose ? (
          <DiagnosePanel phone={phone} onClose={() => setShowDiagnose(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setShowDiagnose(true)}
            style={{ width: "100%", marginTop: 16, border: `1px solid ${ui.borderStrong}`, background: "transparent", borderRadius: ui.radius.button, padding: "12px 16px", color: ui.textPrimary, fontWeight: 600, fontSize: 14, cursor: "pointer" }}
          >
            App not working? Tap here — it will check and fix it
          </button>
        )}
        <p style={{ margin: "22px 0 0", textAlign: "center", color: ui.textTertiary, fontSize: 12 }}>Use the mobile number registered with Student Platform.</p>
      </div>
    </main>
  );
}

