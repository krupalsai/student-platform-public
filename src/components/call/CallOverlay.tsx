"use client";

import { Mic, MicOff, PhoneOff, Loader2, Volume2, Volume1, AlertCircle } from "lucide-react";
import type { CallPhase } from "@/lib/hooks/useVoiceCall";
import { initials, callClock } from "@/lib/call-format";
import RingingHalo from "./RingingHalo";

const ACCENT = "#1d4ed8"; // blue-700, item #78

function label(phase: CallPhase, peer: string): string {
  switch (phase) {
    case "requesting-mic": return "Switching on your microphone…";
    case "ringing":        return `Ringing ${peer}…`;
    case "connecting":     return "Connecting…";
    case "connected":      return peer;
    case "ended":          return "Call ended";
    case "failed":         return "Call failed";
    default:               return "";
  }
}

/** One deliberate control, not a loose icon — caption + tactile press feel
 * is what makes a native dialer's button row read as designed rather than
 * assembled. */
function ControlButton({
  onClick, active, danger, disabled, ariaLabel, caption, icon,
}: {
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  caption: string;
  icon: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9 }}>
      <button
        onClick={onClick}
        aria-label={ariaLabel}
        disabled={disabled}
        className="transition-transform active:scale-90"
        style={{
          width: 64, height: 64, borderRadius: "50%", border: danger ? "none" : "1px solid rgba(255,255,255,0.14)",
          background: danger
            ? "linear-gradient(155deg, #ef4444, #dc2626)"
            : active ? "#fff" : "rgba(255,255,255,0.09)",
          color: danger ? "#fff" : active ? "#0f172a" : "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
          boxShadow: danger
            ? "0 8px 22px -6px rgba(220,38,38,0.65)"
            : active ? "0 6px 16px -6px rgba(0,0,0,0.4)" : "none",
          backdropFilter: danger || active ? undefined : "blur(6px)",
          transition: "background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease",
        }}
      >
        {icon}
      </button>
      <span style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", fontWeight: 500, letterSpacing: 0.2 }}>{caption}</span>
    </div>
  );
}

/**
 * The in-call screen, shared by both sides.
 *
 * Deliberately full-screen and deliberately dark: a call is modal in real
 * life, and every reference app this was compared against (WhatsApp, the
 * system dialer, Google Meet) keeps the same immersive dark surface for a
 * call even where the rest of the app is light — this is the one screen
 * that's supposed to look and feel different from the rest of the Student
 * Platform, not match it.
 */
export default function CallOverlay({
  phase, peerName, durationSecs, muted, speakerOn, error,
  onToggleMute, onToggleSpeaker, onEnd, onDismiss,
}: {
  phase: CallPhase;
  peerName: string;
  durationSecs: number;
  muted: boolean;
  speakerOn: boolean;
  error: string | null;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onEnd: () => void;
  onDismiss: () => void;
}) {
  if (phase === "idle") return null;
  const over = phase === "ended" || phase === "failed";
  const live = phase === "connected";
  const ringing = phase === "ringing" || phase === "connecting";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice call"
      style={{
        position: "fixed", inset: 0, zIndex: 120, overflow: "hidden",
        background: "radial-gradient(circle at 50% 32%, #1e3a8a33, transparent 55%), linear-gradient(180deg, #0b1220, #0f172a 55%, #0a0f1c)",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "32px 20px calc(32px + env(safe-area-inset-bottom,0px))", color: "#fff",
      }}
    >
      <div style={{
        position: "fixed", top: "calc(18px + env(safe-area-inset-top,0px))", left: 0, right: 0,
        textAlign: "center", fontSize: 11, fontWeight: 700, letterSpacing: 1.6,
        textTransform: "uppercase", color: "rgba(255,255,255,0.35)",
      }}>
        Student Platform Voice Call
      </div>

      <div style={{ position: "relative", width: 128, height: 128, marginBottom: 26 }}>
        {/* Soft ambient glow behind the avatar — the difference between a flat
            icon-on-background and something that reads as lit from within. */}
        <div style={{
          position: "absolute", inset: -22, borderRadius: "50%",
          background: over ? "transparent" : "radial-gradient(circle, #1d4ed855, transparent 70%)",
          filter: "blur(6px)",
        }} />
        {ringing && <RingingHalo />}
        <div style={{
          position: "relative", width: 128, height: 128, borderRadius: "50%",
          background: over
            ? "linear-gradient(155deg, #1e293b, #0f172a)"
            : "linear-gradient(155deg, #3b82f6, #1d4ed8)",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: over ? "none" : "0 12px 30px -10px rgba(29,78,216,0.55), inset 0 1px 0 rgba(255,255,255,0.18)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}>
          {phase === "requesting-mic"
            ? <Loader2 size={34} className="animate-spin" strokeWidth={2} />
            : <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: 0.5 }}>{initials(peerName)}</span>}
        </div>
        {live && (
          <span style={{
            position: "absolute", right: 2, bottom: 2, width: 20, height: 20, borderRadius: "50%",
            background: "#22c55e", border: "3px solid #0f172a",
          }} />
        )}
      </div>

      <p style={{ fontSize: 21, fontWeight: 650, marginBottom: 10, textAlign: "center", letterSpacing: 0.1 }}>
        {label(phase, peerName)}
      </p>

      {live ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 7,
          background: "rgba(255,255,255,0.08)", borderRadius: 999, padding: "6px 14px",
        }}>
          <span className="animate-pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "#4ade80" }} />
          <span style={{ fontSize: 14.5, color: "#bfdbfe", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {callClock(durationSecs)}
          </span>
        </div>
      ) : ringing && (
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>Waiting for an answer…</p>
      )}

      {error && (
        <div style={{
          display: "flex", gap: 9, alignItems: "flex-start", maxWidth: 340, marginTop: 18,
          background: "rgba(127,29,29,0.55)", border: "1px solid rgba(248,113,113,0.35)",
          borderRadius: 14, padding: "12px 14px",
        }}>
          <AlertCircle size={17} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1, color: "#fca5a5" }} />
          <p style={{ fontSize: 13.5, lineHeight: 1.45 }}>{error}</p>
        </div>
      )}

      <div style={{ display: "flex", gap: 24, marginTop: 44 }}>
        {!over && (
          <>
            <ControlButton
              onClick={onToggleMute}
              active={muted}
              disabled={!live}
              ariaLabel={muted ? "Unmute microphone" : "Mute microphone"}
              caption={muted ? "Unmute" : "Mute"}
              icon={muted ? <MicOff size={23} strokeWidth={2} /> : <Mic size={23} strokeWidth={2} />}
            />
            <ControlButton
              onClick={onToggleSpeaker}
              active={speakerOn}
              disabled={!live}
              ariaLabel={speakerOn ? "Turn speaker off" : "Turn speaker on"}
              caption="Speaker"
              icon={speakerOn ? <Volume2 size={23} strokeWidth={2} /> : <Volume1 size={23} strokeWidth={2} />}
            />
          </>
        )}
        <ControlButton
          onClick={over ? onDismiss : onEnd}
          danger={!over}
          ariaLabel={over ? "Close" : "End call"}
          caption={over ? "Close" : "End"}
          icon={<PhoneOff size={23} strokeWidth={2} />}
        />
      </div>

      <p style={{ fontSize: 12.5, color: "rgba(255,255,255,0.32)", marginTop: 26 }}>
        {over ? "Tap to close" : "Keep this screen open during the call"}
      </p>
    </div>
  );
}
