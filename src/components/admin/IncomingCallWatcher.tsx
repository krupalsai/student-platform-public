"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useVoiceCall } from "@/lib/hooks/useVoiceCall";
import { useRingtone } from "@/lib/hooks/useRingtone";
import CallOverlay from "@/components/call/CallOverlay";
import IncomingCallScreen from "@/components/call/IncomingCallScreen";

export default function IncomingCallWatcher() {
  const pathname = usePathname();
  const [role, setRole] = useState<string | null>(null);
  const call = useVoiceCall("admin");

  useEffect(() => { setRole(localStorage.getItem("sp_role")); }, []);

  const top = call.incoming[0] ?? null;

  useRingtone(top?.id ?? null);

  const busy = ["requesting-mic", "connecting", "connected"].includes(call.phase);

  if (pathname === "/admin/login" || pathname === "/admin/install") return null;
  if (role !== null && role !== "super_admin") return null;

  const showBanner = !!top && !busy;

  return (
    <>
      {showBanner && top && (
        <IncomingCallScreen
          name={top.student_name}
          subtitle={[top.batch_name, top.reason].filter(Boolean).join(" · ") || "is calling"}
          queueCount={call.incoming.length - 1}
          onAnswer={() => void call.answerCall(top)}
          onDecline={() => void call.declineCall(top.id)}
        />
      )}

      <CallOverlay
        phase={call.phase}
        peerName={top?.student_name ?? "Student"}
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
