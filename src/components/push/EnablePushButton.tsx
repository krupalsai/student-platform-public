"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getVapidPublicKey, isPushSupported, requestAndSubscribeToPush, syncPushSubscription } from "@/lib/push/subscribe-client";

type Status = "checking" | "hidden" | "offer" | "busy" | "done" | "denied" | "error" | "signin";

/**
 * Asks the server whether this browser holds a live session. The
 * sp_session cookie is the proof — localStorage sp_token is not, because
 * a signed-in user can hold a valid cookie with an empty localStorage
 * (handoff race, direct visit, cleared storage). Returns true when the
 * server confirms a session, false when it says the session is gone, and
 * null when the check itself could not be answered (network/timeout) —
 * null is "could not tell", never "signed out", so callers fall through
 * to the subscribe flow and let the server answer there.
 */
async function fetchLiveSession(): Promise<boolean | null> {
  try {
    const res = await Promise.race([
      fetch("/api/auth/session", { cache: "no-store" }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    if (!res) return null;
    const j = await res.json().catch(() => null);
    return res.ok && j?.success === true;
  } catch {
    return null;
  }
}

/**
 * Browser push opt-in for authenticated students.
 *
 * The VAPID public key is fetched from the server instead of reading a
 * NEXT_PUBLIC_* environment variable in the browser bundle. Public env
 * values are embedded into client JS by Next.js, so a misconfigured value
 * must never be able to expose the VAPID private key.
 *
 * Shares its actual permission-request/subscribe logic with
 * NotificationGate (the full-screen required prompt) via
 * @/lib/push/subscribe-client — this component's own job is just being the
 * always-available, low-friction version on the dashboard.
 */
export default function EnablePushButton() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!isPushSupported()) {
        if (!cancelled) setStatus("hidden");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setStatus("hidden");
        return;
      }
      // Notifications can only be linked to a signed-in account. Without a
      // session there is nothing to link to — offering "Enable" just runs
      // the whole permission + subscribe flow and fails at the last step
      // (live 9 Nov 2026: the button sat on "Enabling…" on an expired
      // session). Send the person to sign in instead. Proven by the
      // server (cookie), not localStorage — see fetchLiveSession.
      if ((await fetchLiveSession()) === false) {
        if (!cancelled) setStatus("signin");
        return;
      }
      try {
        await getVapidPublicKey();
        // Both of these can stall on a slow phone; bound them like the
        // shared subscribe helpers do, so the check can never hang the card.
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
        if (!reg) {
          if (!cancelled) setStatus("offer");
          return;
        }
        const existing = await Promise.race([
          reg.pushManager.getSubscription(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
        if (existing) {
          await syncPushSubscription(existing);
          if (!cancelled) setStatus("done");
        } else if (!cancelled) {
          setStatus("offer");
        }
      } catch (e) {
        console.error("[push] subscription check/sync failed", e);
        if (!cancelled) {
          if (e instanceof Error && e.message.includes("session has expired")) {
            setStatus("signin");
          } else {
            setErrorText(e instanceof Error ? e.message : "Notifications could not be connected.");
            setStatus("offer");
          }
        }
      }
    }
    check();
    return () => { cancelled = true; };
  }, []);

  async function enable() {
    // No session, no subscribe — go sign in instead of hanging mid-flow.
    // Proven by the server (cookie), not localStorage — see
    // fetchLiveSession. A "could not tell" (null) lets the flow run; the
    // server's 401 still surfaces as "session expired" from the subscribe
    // call.
    if ((await fetchLiveSession()) === false) {
      router.replace("/login");
      return;
    }
    setStatus("busy");
    setErrorText("");
    try {
      const { granted } = await requestAndSubscribeToPush();
      if (granted) {
        setStatus("done");
      } else if (Notification.permission === "denied") {
        setStatus("denied");
      } else {
        // Not denied — the flow just could not finish (slow network, no
        // service worker). Say so plainly and let them tap again.
        setErrorText("Couldn't finish turning on notifications. Check your connection and try again.");
        setStatus("error");
      }
    } catch (e) {
      console.error("[push] enable failed", e);
      setErrorText(e instanceof Error ? e.message : "Could not save notification access. Please try again.");
      setStatus("error");
    }
  }

  if (status === "hidden" || status === "checking" || status === "done") return null;

  if (status === "signin") {
    return (
      <div style={{ padding: 16, borderRadius: 20, background: "#ffffff", boxShadow: "0 2px 16px rgba(0,0,0,0.06)", color: "#4b4b58", fontSize: 13 }}>
        <p style={{ margin: "0 0 10px", lineHeight: 1.5 }}>
          Your session has expired. Sign in to turn on notifications.
        </p>
        <button
          type="button"
          onClick={() => router.replace("/login")}
          style={{ width: "100%", border: 0, borderRadius: 12, padding: "11px 14px", background: "#0066cc", color: "#fff", fontWeight: 700, fontSize: 13 }}
        >
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, borderRadius: 20, background: "#ffffff", boxShadow: "0 2px 16px rgba(0,0,0,0.06)", color: "#4b4b58", fontSize: 13 }}>
      {status === "denied" ? (
        <p style={{ margin: 0 }}>Notifications are blocked in this browser. WhatsApp remains the fallback.</p>
      ) : (
        <>
          <p style={{ margin: "0 0 10px", lineHeight: 1.5 }}>
            Get Student Platform announcements, discussion messages and important updates as phone notifications.
          </p>
          {errorText && <p style={{ margin: "0 0 10px", color: "#b45309" }}>{errorText}</p>}
          <button
            type="button"
            disabled={status === "busy"}
            onClick={enable}
            style={{ width: "100%", border: 0, borderRadius: 12, padding: "11px 14px", background: "#0066cc", color: "#fff", fontWeight: 700, fontSize: 13, opacity: status === "busy" ? 0.6 : 1 }}
          >
            {status === "busy" ? "Enabling…" : "Enable notifications"}
          </button>
        </>
      )}
    </div>
  );
}
