"use client";

import { useVoiceCall } from "@/lib/hooks/useVoiceCall";
import { useRingtone } from "@/lib/hooks/useRingtone";
import CallOverlay from "./CallOverlay";
import IncomingCallScreen from "./IncomingCallScreen";

/**
 * Live-reported as "this never work" — a student tapping "Call an admin"
 * rang into an admin console tab that may not even be open, and often just
 * sat on "Ringing Admin... Waiting for an answer" forever. Removed the
 * ability for a student to PLACE that call at all (the button, the reason
 * picker, `startCall()`): live human availability isn't something this app
 * can guarantee, and the AI callback (FAQModal's "Request AI Callback",
 * items #189/#190 — Bolna actually dials the student's real phone) is the
 * real, working "someone answers" path now.
 *
 * Still renders nothing visible in the common case, but stays mounted so a
 * student can receive and answer an admin-INITIATED callback (the admin's
 * own AdminCallbackPanel tool, a separate feature that has actually
 * connected calls before, per item #143) — that direction wasn't reported
 * broken and isn't what this removal is about.
 */
export default function StudentCallButton() {
  const call = useVoiceCall("student");
  const callback = call.callbackIncoming;
  // The banner alone was silent — nothing audible or felt even while looking
  // right at the screen, unless the tab happened to be open (item #142).
  useRingtone(callback?.id ?? null);
  const busy = ["requesting-mic", "connecting", "connected"].includes(call.phase);

  return (
    <>
      {callback && !busy && (
        <IncomingCallScreen
          name={callback.admin_name || "Super Admin"}
          subtitle="is calling you back"
          onAnswer={() => void call.answerCallback()}
          onDecline={() => void call.declineCallback()}
        />
      )}

      <CallOverlay
        phase={call.phase}
        peerName="Admin"
        durationSecs={call.durationSecs}
        muted={call.muted}
        speakerOn={call.speakerOn}
        error={call.error}
        onToggleMute={call.toggleMute}
        onToggleSpeaker={call.toggleSpeaker}
        onEnd={() => void call.endCall()}
        onDismiss={call.dismiss}
      />
    </>
  );
}
