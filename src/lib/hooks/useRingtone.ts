"use client";

import { useEffect, useRef } from "react";

/**
 * Browser-safe ringtone + vibration for an incoming call banner. No asset or
 * download is required — Web Audio synthesizes the tone.
 *
 * `callId` is the identity of the thing ringing (a call/callback id, or
 * null when nothing is). Passing an id rather than a bare boolean means a
 * SECOND call arriving while the first is still showing rings again instead
 * of being silently treated as "already ringing."
 *
 * Extracted rather than duplicated a third time: this exact logic first
 * shipped only on the admin side (IncomingCallWatcher). The student side's
 * incoming-callback banner had none of it — no sound, no vibration, only a
 * silent banner that required the student to already be looking at an open
 * tab — which is the literal cause of a live report ("their phone not
 * ringing") once an admin called a student back.
 */
export function useRingtone(callId: string | null) {
  const rungForRef = useRef<string | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const stop = () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      const ctx = audioCtxRef.current;
      if (ctx) {
        void ctx.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };

    if (!callId) {
      rungForRef.current = null;
      stop();
      return;
    }
    if (rungForRef.current === callId) return;
    rungForRef.current = callId;

    try { navigator.vibrate?.([300, 150, 300, 700]); } catch {}

    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;

      const ring = () => {
        const now = ctx.currentTime;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
        gain.gain.setValueAtTime(0.22, now + 0.32);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

        for (const frequency of [440, 480]) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = frequency;
          osc.connect(gain);
          osc.start(now);
          osc.stop(now + 0.4);
        }
        gain.connect(ctx.destination);
      };

      void ctx.resume().then(ring).catch(() => {});
      timerRef.current = window.setInterval(ring, 1200);
    } catch {}

    return stop;
  }, [callId]);
}
