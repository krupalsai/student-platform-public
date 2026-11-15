"use client";
import { useEffect, useState } from "react";
import { ChevronRight, X } from "lucide-react";

export interface CoachMarkStep {
  /** CSS selector for the real button/element this step points at. */
  selector: string;
  title: string;
  text: string;
}

const ACCENT = "#1d4ed8"; // blue-700, matches the rest of the student app

/**
 * Points a real spotlight + tooltip at the app's actual buttons, one at a
 * time, instead of describing them on a separate slide (replaces the old
 * OnboardingIntro.tsx, which only ever showed generic slides). The
 * highlighted element is never covered by the backdrop — the 4 strips
 * around it leave a literal hole — so tapping the real button works
 * exactly as it always does; a student can follow the tour with Next or
 * just use the app directly and the tour gets out of the way.
 *
 * Each host page mounts one of these per screen/step it wants to explain,
 * gated on that content actually being ready (see register/page.tsx,
 * dashboard/page.tsx, etc.) — `tourKey` must be unique per mount point so
 * each one's "seen" flag in localStorage is independent and a tour that
 * never got its target on screen doesn't block a different one.
 */
export default function CoachMarkTour({ tourKey, steps }: { tourKey: string; steps: CoachMarkStep[] }) {
  const storageKey = `sp_tour_${tourKey}`;
  const [visible, setVisible] = useState(false);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    try {
      if (steps.length && !localStorage.getItem(storageKey)) setVisible(true);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let tries = 0;

    function locate() {
      if (cancelled) return;
      const el = document.querySelector(steps[i].selector) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        setTimeout(() => { if (!cancelled) setRect(el.getBoundingClientRect()); }, 260);
      } else if (tries < 20) {
        tries += 1;
        setTimeout(locate, 150);
      } else {
        // Target never appeared on this device/state — don't get stuck.
        advance();
      }
    }
    setRect(null);
    locate();

    const onReflow = () => {
      const el = document.querySelector(steps[i].selector) as HTMLElement | null;
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, i]);

  function finish() {
    try { localStorage.setItem(storageKey, "1"); } catch {}
    setVisible(false);
  }
  function advance() {
    if (i >= steps.length - 1) finish();
    else setI(n => n + 1);
  }

  if (!visible || !steps.length || !rect) return null;

  const pad = 8;
  const box = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const showBelow = box.top + box.height + 190 < vh;
  const tooltipWidth = Math.min(300, vw - 32);
  const tooltipLeft = Math.min(Math.max(box.left + box.width / 2 - tooltipWidth / 2, 16), vw - tooltipWidth - 16);

  const step = steps[i];
  const isLast = i === steps.length - 1;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300 }}>
      {/* 4 backdrop strips around the spotlight — never covers the real target */}
      <div onClick={finish} style={{ position: "fixed", left: 0, top: 0, right: 0, height: Math.max(box.top, 0), background: "rgba(15,23,42,0.68)" }} />
      <div onClick={finish} style={{ position: "fixed", left: 0, top: box.top + box.height, right: 0, bottom: 0, background: "rgba(15,23,42,0.68)" }} />
      <div onClick={finish} style={{ position: "fixed", left: 0, top: box.top, width: Math.max(box.left, 0), height: box.height, background: "rgba(15,23,42,0.68)" }} />
      <div onClick={finish} style={{ position: "fixed", left: box.left + box.width, top: box.top, right: 0, height: box.height, background: "rgba(15,23,42,0.68)" }} />

      {/* Highlight ring, purely visual */}
      <div style={{
        position: "fixed", left: box.left, top: box.top, width: box.width, height: box.height,
        borderRadius: 14, border: `2.5px solid ${ACCENT}`, boxShadow: `0 0 0 4px ${ACCENT}33`, pointerEvents: "none",
      }} />

      <div style={{
        position: "fixed", left: tooltipLeft, width: tooltipWidth,
        top: showBelow ? box.top + box.height + 14 : undefined,
        bottom: showBelow ? undefined : vh - box.top + 14,
        background: "#fff", borderRadius: 16, padding: 16,
        boxShadow: "0 12px 32px rgba(15,23,42,0.28)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <p style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", margin: 0 }}>{step.title}</p>
          <button onClick={finish} aria-label="Skip tour" style={{ background: "none", border: "none", cursor: "pointer", color: "#64748b", padding: 2, flexShrink: 0 }}>
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: "#475569", lineHeight: 1.55, margin: "6px 0 0" }}>{step.text}</p>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
          <div style={{ display: "flex", gap: 4 }}>
            {steps.map((_, idx) => (
              <span key={idx} style={{ width: idx === i ? 16 : 5, height: 5, borderRadius: 999, background: idx === i ? ACCENT : "#e2e8f0", transition: "width 0.2s" }} />
            ))}
          </div>
          <button onClick={advance} style={{ display: "flex", alignItems: "center", gap: 4, background: ACCENT, color: "#fff", border: "none", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>
            {isLast ? "Got it" : "Next"}
            {!isLast && <ChevronRight size={14} strokeWidth={2.5} />}
          </button>
        </div>
      </div>
    </div>
  );
}
