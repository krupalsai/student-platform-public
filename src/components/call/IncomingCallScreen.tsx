"use client";

import { Phone, PhoneOff } from "lucide-react";
import { initials } from "@/lib/call-format";
import RingingHalo from "./RingingHalo";

/**
 * The full-screen "someone is calling you" takeover, shown BEFORE either
 * side answers.
 *
 * Live report: "when calling it not ringing on the receiver side, only just
 * small message" — the only thing a callee ever saw was a small card
 * pinned to the top of whatever page they were on (StudentCallButton /
 * IncomingCallWatcher's old inline banners), easy to miss and nothing like
 * a real incoming call. `useRingtone` already makes the device ring/vibrate
 * (item #142) — this is the missing visual half: a real phone/WhatsApp-style
 * full-screen call screen, not a dismissible strip.
 *
 * Deliberately a SEPARATE component from CallOverlay, not a new phase on it:
 * CallOverlay renders the ACTIVE call (this side has already committed mic
 * + a peer connection). This screen renders BEFORE any of that — no
 * microphone permission has been requested yet, nothing to tear down if the
 * callee just declines.
 */
export default function IncomingCallScreen({
  name, subtitle, queueCount, onAnswer, onDecline, answerLabel = "Answer",
}: {
  name: string;
  subtitle?: string | null;
  /** How many OTHER calls are also ringing right now, if any (admin side,
   *  multiple students calling in). Shown so a queue reads as "3 more
   *  waiting", not as calls silently vanishing/replacing one another. */
  queueCount?: number;
  onAnswer: () => void;
  onDecline: () => void;
  answerLabel?: string;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`Incoming call from ${name}`}
      style={{
        position: "fixed", inset: 0, zIndex: 120, overflow: "hidden",
        background: "radial-gradient(circle at 50% 30%, #1e3a8a33, transparent 55%), linear-gradient(180deg, #0b1220, #0f172a 55%, #0a0f1c)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "32px 20px calc(32px + env(safe-area-inset-bottom,0px))", color: "#fff",
      }}
    >
      <div style={{
        position: "fixed", top: "calc(18px + env(safe-area-inset-top,0px))", left: 0, right: 0,
        textAlign: "center", fontSize: 11, fontWeight: 700, letterSpacing: 1.6,
        textTransform: "uppercase", color: "rgba(255,255,255,0.35)",
      }}>
        Incoming Call
      </div>

      <div style={{ position: "relative", width: 132, height: 132, marginBottom: 26 }}>
        <div style={{
          position: "absolute", inset: -22, borderRadius: "50%",
          background: "radial-gradient(circle, #1d4ed855, transparent 70%)",
          filter: "blur(6px)",
        }} />
        <RingingHalo />
        <div style={{
          position: "relative", width: 132, height: 132, borderRadius: "50%",
          background: "linear-gradient(155deg, #3b82f6, #1d4ed8)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 12px 30px -10px rgba(29,78,216,0.55), inset 0 1px 0 rgba(255,255,255,0.18)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}>
          <span style={{ fontSize: 42, fontWeight: 700, letterSpacing: 0.5 }}>{initials(name)}</span>
        </div>
      </div>

      <p style={{ fontSize: 23, fontWeight: 700, marginBottom: 6, textAlign: "center", letterSpacing: 0.1 }}>
        {name}
      </p>
      <p style={{ fontSize: 14, color: "rgba(255,255,255,0.55)", marginBottom: 4, textAlign: "center" }}>
        {subtitle || "is calling you"}
      </p>
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>is calling…</p>

      {!!queueCount && queueCount > 0 && (
        <div style={{
          marginTop: 14, background: "rgba(255,255,255,0.08)", borderRadius: 999,
          padding: "6px 14px", fontSize: 12.5, color: "rgba(255,255,255,0.75)", fontWeight: 600,
        }}>
          +{queueCount} more {queueCount === 1 ? "call" : "calls"} waiting
        </div>
      )}

      <div style={{ display: "flex", gap: 48, marginTop: 48 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9 }}>
          <button
            onClick={onDecline}
            aria-label="Decline call"
            className="transition-transform active:scale-90"
            style={{
              width: 68, height: 68, borderRadius: "50%", border: "none",
              background: "linear-gradient(155deg, #ef4444, #dc2626)", color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
              boxShadow: "0 8px 22px -6px rgba(220,38,38,0.65)",
            }}
          >
            <PhoneOff size={26} strokeWidth={2} />
          </button>
          <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.7)", fontWeight: 500 }}>Decline</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9 }}>
          <button
            onClick={onAnswer}
            aria-label="Answer call"
            className="transition-transform active:scale-90"
            style={{
              width: 68, height: 68, borderRadius: "50%", border: "none",
              background: "linear-gradient(155deg, #22c55e, #16a34a)", color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
              boxShadow: "0 8px 22px -6px rgba(22,163,74,0.65)",
            }}
          >
            <Phone size={26} strokeWidth={2} />
          </button>
          <span style={{ fontSize: 12.5, color: "rgba(255,255,255,0.7)", fontWeight: 500 }}>{answerLabel}</span>
        </div>
      </div>
    </div>
  );
}
