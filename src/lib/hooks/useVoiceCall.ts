"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * In-app voice calling, student ⇄ admin.
 *
 * Media uses Cloudflare Realtime SFU. Signalling only exchanges the SFU
 * sessionId/trackName; audio itself never goes through our API.
 */

export type CallPhase =
  | "idle"
  | "requesting-mic"
  | "ringing"
  | "connecting"
  | "connected"
  | "ended"
  | "failed";

export interface IncomingCall {
  id: string;
  student_id: string;
  batch_id: string | null;
  student_name: string;
  student_phone: string | null;
  batch_name: string | null;
  reason: string | null;
  created_at: string;
}

const POLL_MS_ESTABLISHING = 100;
const POLL_MS_CONNECTED = 1000;

interface SfuIdentity { sessionId: string; trackName: string }

function sessionHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = localStorage.getItem("sp_token")?.trim() ?? "";
  return token ? { Authorization: `Bearer ${token}`, "x-session-token": token } : {};
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...sessionHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new Error(json?.error ?? "Something went wrong on the call.");
  }
  return json.data as T;
}

async function getMicrophone(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot make calls. Try opening the app in Chrome or Safari.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
        sampleSize: 16,
      },
      video: false,
    });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error("Microphone permission was blocked. Allow microphone access for this site, then try again.");
    }
    if (name === "NotFoundError") throw new Error("No microphone was found on this device.");
    throw new Error("Could not switch on the microphone. Close any other app using it and try again.");
  }
}

export function useVoiceCall(role: "student" | "admin") {
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [durationSecs, setDurationSecs] = useState(0);
  const [incoming, setIncoming] = useState<IncomingCall[]>([]);
  const [callbackIncoming, setCallbackIncoming] = useState<{ id: string; batch_id: string | null; admin_name: string | null } | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const remotePcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const callIdRef = useRef<string | null>(null);
  const batchIdRef = useRef<string | null>(null);
  const sfuSessionRef = useRef<string | null>(null);
  const remoteSfuSessionRef = useRef<string | null>(null);
  const cursorRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulledRef = useRef<Set<string>>(new Set());
  const pullRetryRef = useRef<Map<string, number>>(new Map());
  const phaseRef = useRef<CallPhase>("idle");
  const liveRef = useRef(true);
  /**
   * ICE servers for this call, fetched once and shared by the publish and
   * receive peer connections so both take the same network path.
   *
   * Defaults to STUN-only — what the app used before TURN existed — so a
   * failed or unconfigured fetch degrades to today's behaviour rather than
   * blocking the call.
   */
  const iceServersRef = useRef<RTCIceServer[]>([{ urls: "stun:stun.cloudflare.com:3478" }]);

  /**
   * STUN alone cannot carry media: it only reveals a peer's public address.
   * Behind the symmetric/carrier-grade NAT normal on Indian mobile networks
   * there is often no direct path, and with no relay the call had nothing to
   * fall back on — which is why connection failures, one-way audio, choppy
   * audio and mid-call drops were all reported together.
   */
  const loadIceServers = useCallback(async () => {
    try {
      const data = await api<{ iceServers?: RTCIceServer[]; turn?: boolean }>("/api/calls/ice-servers");
      if (Array.isArray(data?.iceServers) && data.iceServers.length) {
        iceServersRef.current = data.iceServers;
        if (!data.turn) console.warn("[voice-call] TURN not configured — relay unavailable, calls may fail behind NAT");
      }
    } catch {
      // Keep the STUN-only default; a call that might connect beats no call.
    }
  }, []);

  const setPhaseSafe = useCallback((p: CallPhase) => {
    phaseRef.current = p;
    if (liveRef.current) setPhase(p);
  }, []);

  const teardown = useCallback((next: CallPhase, message?: string) => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    try { pcRef.current?.close(); } catch {}
    try { remotePcRef.current?.close(); } catch {}
    pcRef.current = null;
    remotePcRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    if (audioElRef.current) audioElRef.current.srcObject = null;
    callIdRef.current = null;
    batchIdRef.current = null;
    sfuSessionRef.current = null;
    remoteSfuSessionRef.current = null;
    remoteStreamRef.current = null;
    cursorRef.current = 0;
    pulledRef.current = new Set();
    pullRetryRef.current.clear();
    if (liveRef.current) {
      setMuted(false);
      setSpeakerOn(false);
      if (message) setError(message);
    }
    setPhaseSafe(next);
  }, [setPhaseSafe]);

  useEffect(() => {
    liveRef.current = true;
    if (typeof document !== "undefined" && !audioElRef.current) {
      const el = document.createElement("audio");
      el.autoplay = true;
      el.setAttribute("playsinline", "true");
      audioElRef.current = el;
      document.body.appendChild(el);
    }
    return () => {
      liveRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
      try { pcRef.current?.close(); } catch {}
      try { remotePcRef.current?.close(); } catch {}
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      audioElRef.current?.remove();
      audioElRef.current = null;
    };
  }, []);

  const markConnected = useCallback(() => {
    if (phaseRef.current === "connected") return;
    setPhaseSafe("connected");
    if (liveRef.current) setDurationSecs(0);
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => { if (liveRef.current) setDurationSecs(d => d + 1); }, 1000);
  }, [setPhaseSafe]);

  const groupCall = useCallback(async (body: Record<string, unknown>) => {
    return api<any>("/api/group-call", {
      method: "POST",
      body: JSON.stringify({ batchId: batchIdRef.current, ...body }),
    });
  }, []);

/**
 * A peer connection can be closed by teardown() while its OWN negotiation is
 * still in flight — the answer then lands on a closed connection and WebRTC
 * throws "Failed to execute 'setRemoteDescription' … signalingState is
 * 'closed'", which reached students as a red "Call failed" on a call that had
 * simply been ended, declined, or hung up mid-setup.
 *
 * The window is wide, not theoretical: ringing/polling now starts BEFORE the
 * publish handshake finishes, so a decline or hang-up routinely lands while
 * these awaits are outstanding.
 *
 * Checking the ref too, not just signalingState, catches the other case: a
 * second attempt replaced the connection, and this stale one must not write
 * its answer over the new one.
 */
const CALL_GONE = "__sp_call_gone__";

function pcStillCurrent(
  pc: RTCPeerConnection,
  ref: { current: RTCPeerConnection | null },
): boolean {
  return ref.current === pc && pc.signalingState !== "closed";
}

  const publishToSfu = useCallback(async (stream: MediaStream): Promise<SfuIdentity> => {
    const pc = new RTCPeerConnection({
      iceServers: iceServersRef.current,
    });
    pcRef.current = pc;

    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("No microphone track was available.");

    const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
    await pc.setLocalDescription(await pc.createOffer());
    if (!pc.localDescription) throw new Error("Could not start the call.");

    const session = await groupCall({ action: "create-session" });
    if (!pcStillCurrent(pc, pcRef)) throw new Error(CALL_GONE);
    if (!session?.sessionId) throw new Error("The call service did not open a session.");
    sfuSessionRef.current = session.sessionId;

    const published = await groupCall({
      action: "tracks",
      sessionId: session.sessionId,
      sessionDescription: { type: "offer", sdp: pc.localDescription.sdp },
      tracks: [{
        location: "local",
        trackName: `sp-${role}-${crypto.randomUUID()}-audio`,
        mid: transceiver.mid ?? null,
      }],
    });

    if (!published?.sessionDescription) {
      throw new Error("The call service did not return an audio answer.");
    }
    // The call may have ended while the SFU was answering.
    if (!pcStillCurrent(pc, pcRef)) throw new Error(CALL_GONE);
    await pc.setRemoteDescription(published.sessionDescription);

    const trackName = published.tracks?.[0]?.trackName;
    if (!trackName) throw new Error("The call service did not return the published audio track.");

    // IMPORTANT: do not wait for ICE/DTLS before announcing the track.
    // Cloudflare's SFU track operation is designed to handle the connection
    // transition. Waiting here added seconds to call setup and made the
    // subscriber start too late. The subscriber retries its pull if the
    // publisher is still connecting.
    return { sessionId: session.sessionId, trackName };
  }, [groupCall, role]);

  const pullRemote = useCallback(async (remote: SfuIdentity) => {
    if (pulledRef.current.has(remote.trackName)) return;
    pulledRef.current.add(remote.trackName);

    try {
      let pc = remotePcRef.current;
      let sessionId = remoteSfuSessionRef.current;

      if (!pc || !sessionId) {
        pc = new RTCPeerConnection({
          iceServers: iceServersRef.current,
        });
        remotePcRef.current = pc;
        remoteStreamRef.current = new MediaStream();

        pc.ontrack = (ev) => {
          if (!ev.track) return;
          const stream = remoteStreamRef.current ?? new MediaStream();
          remoteStreamRef.current = stream;
          if (!stream.getTracks().some(t => t.id === ev.track.id)) {
            stream.addTrack(ev.track);
          }
          if (audioElRef.current) {
            audioElRef.current.srcObject = stream;
            /**
             * A swallowed play() rejection is indistinguishable from a dead
             * call: mobile browsers block playback that is not tied to a user
             * gesture, and the student then hears silence with nothing on
             * screen explaining it. Retry once the page is visible, and if it
             * still refuses, say so instead of failing quietly.
             */
            void audioElRef.current.play().catch(() => {
              const retry = () => {
                audioElRef.current?.play()
                  .then(() => {
                    document.removeEventListener("click", retry);
                    document.removeEventListener("touchstart", retry);
                    if (liveRef.current) setError(null);
                  })
                  .catch(() => {});
              };
              document.addEventListener("click", retry, { once: false });
              document.addEventListener("touchstart", retry, { once: false });
              if (liveRef.current) {
                setError("Tap anywhere to turn on call audio.");
              }
            });
          }
          markConnected();
        };

        const created = await groupCall({ action: "create-session" });
        sessionId = created?.sessionId;
        if (!sessionId) throw new Error("Could not open the audio receive session.");
        remoteSfuSessionRef.current = sessionId;
      }

      const result = await groupCall({
        action: "tracks",
        sessionId,
        tracks: [{
          location: "remote",
          sessionId: remote.sessionId,
          trackName: remote.trackName,
        }],
      });

      if (result?.requiresImmediateRenegotiation && result.sessionDescription?.type === "offer") {
        // Ended mid-handshake: nothing to renegotiate, and writing to a closed
        // connection is what produced the "signalingState is 'closed'" error.
        if (!pcStillCurrent(pc, remotePcRef)) return;
        await pc.setRemoteDescription(result.sessionDescription);
        await pc.setLocalDescription(await pc.createAnswer());
        if (!pc.localDescription) throw new Error("Could not complete the audio receive handshake.");

        await groupCall({
          action: "renegotiate",
          sessionId,
          sessionDescription: {
            type: "answer",
            sdp: pc.localDescription.sdp,
          },
        });
      }
    } catch (e) {
      pulledRef.current.delete(remote.trackName);
      const retries = (pullRetryRef.current.get(remote.trackName) ?? 0) + 1;
      pullRetryRef.current.set(remote.trackName, retries);
      console.error("[voice-call] pull failed:", (e as Error).message);

      if (callIdRef.current && liveRef.current && retries <= 12) {
        const delay = Math.min(250 * retries, 1000);
        setTimeout(() => {
          if (callIdRef.current && liveRef.current && !pulledRef.current.has(remote.trackName)) {
            void pullRemote(remote);
          }
        }, delay);
      }
    }
  }, [groupCall, markConnected]);

  const announceIdentity = useCallback(async (identity: SfuIdentity) => {
    const id = callIdRef.current;
    if (!id) return;
    await api(`/api/calls/${id}/signal`, {
      method: "POST",
      body: JSON.stringify({ kind: "sfu", payload: identity }),
    });
  }, []);

  const poll = useCallback(async () => {
    const id = callIdRef.current;
    if (!id) return;

    try {
      const data = await api<{ call: { status: string }; signals: any[]; cursor: number }>(
        `/api/calls/${id}?since=${cursorRef.current}`,
      );

      for (const sig of data.signals ?? []) {
        if (sig.kind === "sfu" && sig.payload?.sessionId && sig.payload?.trackName) {
          await pullRemote(sig.payload as SfuIdentity);
        }
      }

      // Advance the cursor after processing this batch. The previous version
      // accidentally never advanced it, so the same signal was fetched again
      // every 100–150 ms for the entire call.
      if (typeof data.cursor === "number" && data.cursor > cursorRef.current) {
        cursorRef.current = data.cursor;
      }

      const status = data.call?.status;
      if (status === "declined") {
        return teardown("ended", role === "student" ? "The admin could not take your call right now." : undefined);
      }
      if (status === "missed") {
        return teardown("ended", role === "student" ? "No admin picked up. Please try again shortly." : undefined);
      }
      if (status === "ended") return teardown("ended");
      if (status === "accepted" && phaseRef.current === "ringing") setPhaseSafe("connecting");
    } catch {
      // Keep the call alive through transient network/API errors.
    } finally {
      if (callIdRef.current && liveRef.current) {
        const delay = phaseRef.current === "connected" ? POLL_MS_CONNECTED : POLL_MS_ESTABLISHING;
        pollRef.current = setTimeout(() => { void poll(); }, delay);
      }
    }
  }, [pullRemote, teardown, setPhaseSafe, role]);

  const startPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    void poll();
  }, [poll]);

  const startCall = useCallback(async (reason?: string) => {
    if (!["idle", "ended", "failed"].includes(phaseRef.current)) return;
    setError(null);
    setPhaseSafe("requesting-mic");

    try {
      // Mic permission and the ICE fetch are independent — running them
      // together keeps TURN from adding a round trip to call setup.
      const [stream] = await Promise.all([getMicrophone(), loadIceServers()]);
      localStreamRef.current = stream;

      const { call, disabled } = await api<{ call: { id: string; batch_id: string | null } | null; disabled?: boolean }>(
        "/api/calls",
        { method: "POST", body: JSON.stringify({ reason: reason ?? null }) },
      );

      if (disabled || !call) {
        return teardown("failed", "Calling is switched off right now. Please use Contact Support instead.");
      }

      callIdRef.current = call.id;
      batchIdRef.current = call.batch_id;

      // Start ringing/polling immediately after the server creates the call.
      // Do NOT wait for the SFU publish handshake before notifying the admin.
      // The admin can answer while the caller's media session is connecting;
      // both SFU sessions then exchange their track identities independently.
      setPhaseSafe("ringing");
      startPolling();

      try {
        const identity = await publishToSfu(stream);
        await announceIdentity(identity);
      } catch (e) {
        // The ring is a real call state, so clean it up if media setup fails.
        const failedCallId = callIdRef.current;
        if (failedCallId) {
          void api(`/api/calls/${failedCallId}`, {
            method: "POST",
            body: JSON.stringify({ action: "end" }),
          }).catch(() => {});
        }
        throw e;
      }
    } catch (e) {
      if ((e as Error).message === CALL_GONE) return;
      teardown("failed", (e as Error).message);
    }
  }, [announceIdentity, loadIceServers, publishToSfu, setPhaseSafe, startPolling, teardown]);

  const answerCall = useCallback(async (call: IncomingCall) => {
    if (["requesting-mic", "connecting", "connected"].includes(phaseRef.current)) return;
    setError(null);
    setPhaseSafe("requesting-mic");

    try {
      // Mic permission and the ICE fetch are independent — running them
      // together keeps TURN from adding a round trip to call setup.
      const [stream] = await Promise.all([getMicrophone(), loadIceServers()]);
      localStreamRef.current = stream;

      await api(`/api/calls/${call.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "accept" }),
      });

      callIdRef.current = call.id;
      batchIdRef.current = call.batch_id;
      setPhaseSafe("connecting");

      const identity = await publishToSfu(stream);
      await announceIdentity(identity);
      startPolling();
    } catch (e) {
      if ((e as Error).message === CALL_GONE) return;
      teardown("failed", (e as Error).message);
    }
  }, [announceIdentity, loadIceServers, publishToSfu, setPhaseSafe, startPolling, teardown]);

  const startCallback = useCallback(async (studentId: string, batchId: string) => {
    if (role !== "admin" || phaseRef.current !== "idle") return;
    setError(null);
    setPhaseSafe("requesting-mic");

    try {
      // Mic permission and the ICE fetch are independent — running them
      // together keeps TURN from adding a round trip to call setup.
      const [stream] = await Promise.all([getMicrophone(), loadIceServers()]);
      localStreamRef.current = stream;

      const result = await api<{ call: { id: string; batch_id: string | null } }>(
        "/api/calls",
        { method: "POST", body: JSON.stringify({ action: "callback", studentId, batchId }) },
      );
      if (!result?.call?.id) throw new Error("Could not start the callback.");

      callIdRef.current = result.call.id;
      batchIdRef.current = result.call.batch_id ?? batchId;

      const identity = await publishToSfu(stream);
      await announceIdentity(identity);
      setPhaseSafe("ringing");
      startPolling();
    } catch (e) {
      if ((e as Error).message === CALL_GONE) return;
      teardown("failed", (e as Error).message);
    }
  }, [announceIdentity, loadIceServers, publishToSfu, role, setPhaseSafe, startPolling, teardown]);

  const answerCallback = useCallback(async () => {
    const pending = callbackIncoming;
    if (!pending || role !== "student") return;
    setError(null);
    setPhaseSafe("requesting-mic");

    try {
      // Mic permission and the ICE fetch are independent — running them
      // together keeps TURN from adding a round trip to call setup.
      const [stream] = await Promise.all([getMicrophone(), loadIceServers()]);
      localStreamRef.current = stream;

      await api(`/api/calls/${pending.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "accept" }),
      });

      callIdRef.current = pending.id;
      batchIdRef.current = pending.batch_id;
      setCallbackIncoming(null);
      setPhaseSafe("connecting");

      const identity = await publishToSfu(stream);
      await announceIdentity(identity);
      startPolling();
    } catch (e) {
      if ((e as Error).message === CALL_GONE) return;
      teardown("failed", (e as Error).message);
    }
  }, [announceIdentity, callbackIncoming, loadIceServers, publishToSfu, role, setPhaseSafe, startPolling, teardown]);

  const declineCallback = useCallback(async () => {
    const pending = callbackIncoming;
    if (!pending) return;
    try {
      await api(`/api/calls/${pending.id}`, {
        method: "POST",
        body: JSON.stringify({ action: "decline" }),
      });
    } catch {}
    setCallbackIncoming(null);
  }, [callbackIncoming]);

  const declineCall = useCallback(async (callId: string) => {
    try {
      await api(`/api/calls/${callId}`, {
        method: "POST",
        body: JSON.stringify({ action: "decline" }),
      });
    } catch {}
    setIncoming(prev => prev.filter(c => c.id !== callId));
  }, []);

  const endCall = useCallback(async () => {
    const id = callIdRef.current;
    teardown("ended");
    if (id) {
      try {
        await api(`/api/calls/${id}`, {
          method: "POST",
          body: JSON.stringify({ action: "end" }),
        });
      } catch {}
    }
  }, [teardown]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach(t => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  /**
   * There is no web API to move audio between a phone's earpiece and its
   * loudspeaker the way a native dialer does — that is hardware audio-focus
   * routing, and pages cannot touch it. `setSinkId` is the closest real
   * lever: it can redirect an <audio> element to a specific OUTPUT DEVICE,
   * and on Android Chrome that device list includes a "Speaker"/
   * "Speakerphone" entry distinct from the default call-audio route. Where
   * the browser doesn't expose it (notably iOS Safari, which does not
   * implement setSinkId at all), this is a silent no-op rather than an
   * error — the same fail-soft posture as the TURN/ringtone code, because a
   * button that sometimes does nothing is still better than one that throws.
   */
  const toggleSpeaker = useCallback(async () => {
    const next = !speakerOn;
    setSpeakerOn(next);

    const el = audioElRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el || typeof el.setSinkId !== "function") return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter(d => d.kind === "audiooutput");
      const speaker = outputs.find(d => /speaker/i.test(d.label));
      const earpiece = outputs.find(d => /earpiece|receiver/i.test(d.label));

      if (next && speaker) {
        await el.setSinkId(speaker.deviceId);
      } else if (!next && earpiece) {
        await el.setSinkId(earpiece.deviceId);
      } else if (!next) {
        await el.setSinkId("");
      }
    } catch {
      // Unsupported, or the device list came back unlabeled — leave routing
      // as-is rather than surface a call-breaking error over a nice-to-have.
    }
  }, [speakerOn]);

  const dismiss = useCallback(() => {
    setError(null);
    setPhaseSafe("idle");
  }, [setPhaseSafe]);

  useEffect(() => {
    if (role !== "student") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (stop) return;
      const busy = ["requesting-mic", "connecting", "connected"].includes(phaseRef.current);

      if (!busy && !callbackIncoming) {
        try {
          const data = await api<{ call: { id: string; status: string; batch_id: string | null; admin_id: string | null } | null; admin?: { full_name: string | null } | null }>("/api/calls");
          const pending = data.call?.status === "ringing" && data.call.admin_id
            ? { id: data.call.id, batch_id: data.call.batch_id, admin_name: data.admin?.full_name ?? null }
            : null;
          if (!stop && liveRef.current) setCallbackIncoming(pending);
        } catch {}
      }

      if (!stop) timer = setTimeout(() => { void tick(); }, 1500);
    };

    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [role, callbackIncoming]);

  useEffect(() => {
    if (role !== "admin") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (stop) return;
      const busy = ["requesting-mic", "connecting", "connected"].includes(phaseRef.current);

      if (!busy) {
        try {
          const data = await api<{ calls: IncomingCall[] }>("/api/calls");
          if (!stop && liveRef.current) setIncoming(data.calls ?? []);
        } catch {}
      }

      if (!stop) timer = setTimeout(() => { void tick(); }, 3000);
    };

    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [role]);

  return {
    phase,
    error,
    muted,
    durationSecs,
    incoming,
    callbackIncoming,
    startCall,
    answerCall,
    startCallback,
    answerCallback,
    declineCall,
    declineCallback,
    endCall,
    toggleMute,
    speakerOn,
    toggleSpeaker,
    dismiss,
  };
}
