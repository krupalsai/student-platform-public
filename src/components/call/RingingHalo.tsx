"use client";

const ACCENT = "#1d4ed8"; // blue-700, item #78

/**
 * Two staggered rings read as "reaching out" rather than one flat pulse — the
 * offset delay is what a single animate-ping/animate-pulse pair can't give on
 * its own. Shared by CallOverlay (the active-call screen) and
 * IncomingCallScreen (the pre-answer ringing screen) so both use the same
 * "something is calling you" motion instead of two slightly different ones.
 */
export default function RingingHalo() {
  return (
    <>
      <span className="animate-ping" style={{
        position: "absolute", inset: 0, borderRadius: "50%",
        background: ACCENT, opacity: 0.3, animationDuration: "1.8s",
      }} />
      <span className="animate-ping" style={{
        position: "absolute", inset: 0, borderRadius: "50%",
        background: ACCENT, opacity: 0.3, animationDuration: "1.8s", animationDelay: "0.6s",
      }} />
    </>
  );
}
