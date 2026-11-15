"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

type Mode = "voice" | "video";
type Participant = { id: string; name: string; sessionId: string; tracks: { audio?: string; video?: string } };
type LocalTrack = { kind: "audio" | "video"; name: string; mid: string | null };

function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const c = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (name === "mic") return <svg {...c}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg>;
  if (name === "micOff") return <svg {...c}><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.6-1.5M19 10v2a7 7 0 0 1-12.9 3.6M12 19v3M8 22h8M3 3l18 18"/></svg>;
  if (name === "video") return <svg {...c}><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>;
  if (name === "videoOff") return <svg {...c}><path d="m3 3 18 18M16 10l5-3v10l-5-3z"/><path d="M3 7v10a2 2 0 0 0 2 2h9M3 5h11a2 2 0 0 1 2 2v1"/></svg>;
  if (name === "speaker") return <svg {...c}><path d="M11 5 6 9H2v6h4l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18 5a9 9 0 0 1 0 14"/></svg>;
  if (name === "speakerOff") return <svg {...c}><path d="M11 5 6 9H2v6h4l5 4V5ZM22 9l-6 6M16 9l6 6"/></svg>;
  return <svg {...c}><circle cx="12" cy="12" r="9"/></svg>;
}

function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join("").toUpperCase() || "S"; }

function GroupCallContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode: Mode = searchParams.get("mode") === "voice" ? "voice" : "video";
  const requestedBatchId = searchParams.get("batchId");
  const requestedBatchName = searchParams.get("batchName");
  const returnTo = searchParams.get("returnTo");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchName, setBatchName] = useState("Your Batch");
  const [myId, setMyId] = useState<string | null>(null);
  const [myName, setMyName] = useState("You");
  const [participants, setParticipants] = useState<Record<string, Participant>>({});
  const [joined, setJoined] = useState(false);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(mode === "video");
  const [speakerOn, setSpeakerOn] = useState(true);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<any>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pullingRef = useRef(new Set<string>());
  const subscribedTracksRef = useRef(new Set<string>());
  const midOwnersRef = useRef(new Map<string, string>());
  /**
   * ICE servers for this call. Defaults to STUN-only — what this page used
   * before TURN existed — so a failed or unconfigured fetch degrades to the
   * old behaviour rather than blocking the call.
   *
   * STUN alone cannot carry media; it only reveals a peer's public address.
   * Behind the symmetric/carrier-grade NAT normal on Indian mobile networks
   * there is often no direct path, and with no relay a call has nothing to
   * fall back on — which is why failures to connect, one-way audio, choppy
   * audio and mid-call drops were all reported together.
   */
  const iceServersRef = useRef<RTCIceServer[]>([{ urls: "stun:stun.cloudflare.com:3478" }]);

  const authHeaders = useCallback(() => {
    const token = localStorage.getItem("sp_token") ?? "";
    return { Authorization: `Bearer ${token}`, "x-session-token": token, "Content-Type": "application/json" };
  }, []);

  const loadIceServers = useCallback(async () => {
    try {
      const res = await fetch("/api/calls/ice-servers", { headers: authHeaders(), cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      if (Array.isArray(json?.iceServers) && json.iceServers.length) {
        iceServersRef.current = json.iceServers;
        if (!json.turn) console.warn("[group-call] TURN not configured — relay unavailable, calls may fail behind NAT");
      }
    } catch {
      // Keep the STUN-only default; a call that might connect beats no call.
    }
  }, [authHeaders]);

  const api = useCallback(async (body: any) => {
    const res = await fetch("/api/group-call", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error ?? "Call service unavailable");
    return json.data;
  }, [authHeaders]);

  useEffect(() => {
    const token = localStorage.getItem("sp_token");
    if (!token) { router.replace("/"); return; }
    fetch("/api/profile", { headers: { Authorization: `Bearer ${token}`, "x-session-token": token } })
      .then(r => r.json()).then(p => {
        const role = p.data?.role ?? localStorage.getItem("sp_role");
        const targetBatchId = requestedBatchId && role !== "student" ? requestedBatchId : p.data?.batch_id;
        if (!p.success || !targetBatchId || !p.data?.is_profile_complete) { router.replace("/dashboard"); return; }
        setBatchId(targetBatchId); setBatchName((requestedBatchId && requestedBatchName) || p.data.batches?.name || "Your Batch");
        setMyId(p.data.id ?? null); setMyName(p.data.full_name ?? "You");
      }).catch(() => router.replace("/dashboard")).finally(() => setLoading(false));
  }, [router, requestedBatchId, requestedBatchName]);

  const addRemoteTrack = useCallback((participantId: string, track: MediaStreamTrack) => {
    setRemoteStreams(prev => {
      const stream = prev[participantId] ?? new MediaStream();
      if (!stream.getTracks().some(t => t.id === track.id)) stream.addTrack(track);
      return { ...prev, [participantId]: stream };
    });
  }, []);

  const pullParticipant = useCallback(async (participant: Participant) => {
    const pc = pcRef.current, ownSession = sessionIdRef.current;
    if (!pc || !ownSession || participant.id === myId || pullingRef.current.has(participant.id)) return;
    const remoteTracks = [participant.tracks.audio, participant.tracks.video].filter(Boolean).filter(n => !subscribedTracksRef.current.has(n!));
    if (!remoteTracks.length) return;
    pullingRef.current.add(participant.id);
    try {
      remoteTracks.forEach(n => subscribedTracksRef.current.add(n!));
      const result = await api({ batchId, action: "tracks", sessionId: ownSession, tracks: remoteTracks.map(trackName => ({ location: "remote", sessionId: participant.sessionId, trackName })) });
      if (result?.requiresImmediateRenegotiation && result.sessionDescription?.type === "offer") {
        const mids = result.tracks ?? [];
        mids.forEach((t: any) => { if (t.mid) midOwnersRef.current.set(t.mid, participant.id); });
        await pc.setRemoteDescription(result.sessionDescription);
        await pc.setLocalDescription(await pc.createAnswer());
        if (!pc.localDescription) throw new Error("Could not create call answer");
        await api({ batchId, action: "renegotiate", sessionId: ownSession, sessionDescription: { type: "answer", sdp: pc.localDescription.sdp } });
      }
    } catch (e) {
      remoteTracks.forEach(n => subscribedTracksRef.current.delete(n!));
      setError(e instanceof Error ? e.message : "Could not connect to a participant");
    } finally { pullingRef.current.delete(participant.id); }
  }, [api, batchId, myId]);

  useEffect(() => {
    if (joined) Object.values(participants).forEach(p => void pullParticipant(p));
  }, [participants, joined, pullParticipant]);

  const cleanup = useCallback(async () => {
    try { await channelRef.current?.untrack(); } catch {}
    try { await channelRef.current?.unsubscribe(); } catch {}
    channelRef.current = null; pcRef.current?.close(); pcRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop()); localStreamRef.current = null;
    sessionIdRef.current = null; pullingRef.current.clear(); subscribedTracksRef.current.clear(); midOwnersRef.current.clear();
    setRemoteStreams({}); setLocalVideoStream(null); setParticipants({}); setJoined(false);
  }, []);

  const join = useCallback(async () => {
    if (!batchId || !myId || joining || joined) return;
    setJoining(true); setError(null);
    try {
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: true, video: mode === "video" }),
        loadIceServers(),
      ]);
      localStreamRef.current = stream; setLocalVideoStream(mode === "video" ? stream : null);
      const pc = new RTCPeerConnection({ iceServers: iceServersRef.current }); pcRef.current = pc;
      pc.ontrack = event => { const owner = midOwnersRef.current.get(event.transceiver?.mid ?? ""); if (owner) addRemoteTrack(owner, event.track); };
      stream.getTracks().forEach(track => { const t = pc.addTransceiver(track, { direction: "sendonly" }); (t as any).__spTrack = track; });
      await pc.setLocalDescription(await pc.createOffer()); if (!pc.localDescription) throw new Error("Could not create call offer");
      const session = await api({ batchId, action: "session", sessionDescription: { type: "offer", sdp: pc.localDescription.sdp } });
      sessionIdRef.current = session.sessionId; await pc.setRemoteDescription(session.sessionDescription);
      await pc.setLocalDescription(await pc.createOffer()); if (!pc.localDescription) throw new Error("Could not publish media");
      const localTracks: LocalTrack[] = stream.getTracks().map(track => {
        const t = pc.getTransceivers().find(x => (x as any).__spTrack === track);
        return { kind: track.kind as "audio" | "video", name: `sp-${myId}-${track.kind}-${crypto.randomUUID()}`, mid: t?.mid ?? null };
      });
      const publish = await api({ batchId, action: "tracks", sessionId: session.sessionId, sessionDescription: { type: "offer", sdp: pc.localDescription.sdp }, tracks: localTracks.map(t => ({ location: "local", trackName: t.name, mid: t.mid })) });
      if (publish?.sessionDescription) await pc.setRemoteDescription(publish.sessionDescription);
      localTracks.forEach(t => { if (t.mid) midOwnersRef.current.set(t.mid, myId); });
      const presence: Participant = { id: myId, name: myName, sessionId: session.sessionId, tracks: Object.fromEntries(localTracks.map(t => [t.kind, t.name])) };
      const channel = supabase.channel(`group-call:${batchId}`, { config: { presence: { key: myId } } }); channelRef.current = channel;
      const refresh = () => {
        const state = channel.presenceState() as Record<string, Participant[]>; const next: Record<string, Participant> = {};
        Object.values(state).flat().forEach((p: any) => { if (p?.id && p.id !== myId) next[p.id] = p; }); setParticipants(next);
      };
      channel.on("presence", { event: "sync" }, refresh).on("presence", { event: "join" }, refresh).on("presence", { event: "leave" }, refresh);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Could not join the call room")), 10000);
        channel.subscribe(async status => {
          if (status === "SUBSCRIBED") { clearTimeout(timer); await channel.track(presence); resolve(); }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(timer); reject(new Error("Call room connection failed")); }
        });
      });
      setJoined(true);
    } catch (e) { await cleanup(); setError(e instanceof Error ? e.message : "Could not start the call"); }
    finally { setJoining(false); }
  }, [addRemoteTrack, api, batchId, cleanup, joined, joining, loadIceServers, mode, myId, myName]);

  useEffect(() => () => { void cleanup(); }, [cleanup]);
  const toggleMute = () => { const t = localStreamRef.current?.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; setMuted(!t.enabled); };
  const toggleCamera = () => { const t = localStreamRef.current?.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled; setCameraOn(t.enabled); };
  const leave = async () => { await cleanup(); router.replace(returnTo || "/discussion"); };
  const switchMode = async () => { await cleanup(); router.replace(`/discussion/call?mode=${mode === "voice" ? "video" : "voice"}`); };
  const allParticipants = useMemo(() => [{ id: myId ?? "me", name: myName, local: true }, ...Object.values(participants).map(p => ({ id: p.id, name: p.name, local: false }))], [myId, myName, participants]);

  if (loading || !batchId || !myId) return <div className="h-[100dvh] bg-white flex items-center justify-center text-sm text-slate-400">Preparing group call…</div>;
  return <div className="h-[100dvh] overflow-hidden bg-slate-950 text-white flex flex-col">
    <header className="fixed top-0 inset-x-0 z-30 bg-white text-slate-900 border-b border-slate-200 shadow-sm pt-[env(safe-area-inset-top)]"><div className="h-[76px] px-4 flex items-center gap-3">
      <button onClick={leave} className="w-10 h-10 rounded-full border border-slate-200 flex items-center justify-center" aria-label="Back"><span className="text-2xl">‹</span></button>
      <div className="min-w-0 flex-1"><h1 className="font-bold text-[18px] truncate">Group {mode === "voice" ? "Voice" : "Video"} Call</h1><p className="text-sm text-slate-400 truncate">{batchName} · {allParticipants.length} {allParticipants.length === 1 ? "participant" : "participants"}</p></div>
      <button onClick={switchMode} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">{mode === "voice" ? "Video" : "Voice"}</button>
    </div></header>
    <main className="flex-1 overflow-y-auto pt-[calc(76px+env(safe-area-inset-top))] pb-[calc(96px+env(safe-area-inset-bottom))] px-3">
      {!joined ? <div className="min-h-full flex items-center justify-center"><div className="w-full max-w-md rounded-3xl bg-white text-slate-900 p-7 text-center shadow-xl">
        <div className="w-20 h-20 mx-auto rounded-full bg-slate-100 flex items-center justify-center mb-5"><Icon name={mode === "voice" ? "mic" : "video"} size={34}/></div><h2 className="text-xl font-bold">Join {mode === "voice" ? "voice" : "video"} call</h2>
        <p className="text-sm text-slate-500 mt-2">This call runs directly inside Student Platform. No external meeting app is required.</p>{error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        <button disabled={joining} onClick={join} className="mt-6 w-full rounded-2xl bg-slate-900 text-white py-3.5 font-bold disabled:opacity-50">{joining ? "Connecting…" : "Join call"}</button>
      </div></div> : <div className={`max-w-5xl mx-auto grid gap-3 content-start ${allParticipants.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
        {allParticipants.map(p => { const stream = p.local ? localVideoStream : remoteStreams[p.id]; return <div key={p.id} className={`relative overflow-hidden rounded-2xl bg-slate-900 border border-white/10 ${allParticipants.length === 1 ? "aspect-video max-h-[70vh]" : "aspect-[4/3]"}`}>
          {mode === "video" && stream ? <video autoPlay playsInline muted={p.local || !speakerOn} ref={el => { if (el && el.srcObject !== stream) el.srcObject = stream; }} className="w-full h-full object-cover"/> : <div className="w-full h-full flex flex-col items-center justify-center"><div className="w-20 h-20 rounded-full bg-slate-700 flex items-center justify-center text-2xl font-bold">{initials(p.name)}</div><span className="mt-3 text-sm font-semibold">{p.local ? "You" : p.name}</span>{!p.local && <audio autoPlay playsInline muted={!speakerOn} ref={el => { if (el && stream && el.srcObject !== stream) el.srcObject = stream; }}/>}</div>}
          <div className="absolute left-3 bottom-3 rounded-full bg-black/55 backdrop-blur px-3 py-1.5 text-xs font-semibold">{p.local ? "You" : p.name}</div>{p.local && muted && <div className="absolute right-3 bottom-3 rounded-full bg-black/55 p-2"><Icon name="micOff" size={14}/></div>}
        </div>; })}
      </div>}
      {joined && error && <div className="fixed top-[90px] left-1/2 -translate-x-1/2 z-20 rounded-full bg-red-600 px-4 py-2 text-xs font-semibold shadow-lg">{error}</div>}
    </main>
    {joined && <footer className="fixed bottom-0 inset-x-0 z-30 bg-slate-950/95 backdrop-blur border-t border-white/10 pb-[env(safe-area-inset-bottom)]"><div className="h-[88px] flex items-center justify-center gap-3 px-4">
      <button onClick={toggleMute} className={`w-14 h-14 rounded-full flex items-center justify-center ${muted ? "bg-white text-slate-900" : "bg-white/10"}`} aria-label={muted ? "Unmute" : "Mute"}><Icon name={muted ? "micOff" : "mic"}/></button>
      {mode === "video" && <button onClick={toggleCamera} className={`w-14 h-14 rounded-full flex items-center justify-center ${!cameraOn ? "bg-white text-slate-900" : "bg-white/10"}`} aria-label="Camera"><Icon name={cameraOn ? "video" : "videoOff"}/></button>}
      <button onClick={() => setSpeakerOn(v => !v)} className={`w-14 h-14 rounded-full flex items-center justify-center ${!speakerOn ? "bg-white text-slate-900" : "bg-white/10"}`} aria-label="Speaker"><Icon name={speakerOn ? "speaker" : "speakerOff"}/></button>
      <button onClick={leave} className="w-14 h-14 rounded-full bg-red-600 flex items-center justify-center" aria-label="End call"><span className="text-2xl">✕</span></button>
    </div></footer>}
  </div>;
}

export default function GroupCallPage() { return <Suspense fallback={<div className="h-[100dvh] bg-white flex items-center justify-center text-sm text-slate-400">Preparing group call…</div>}><GroupCallContent/></Suspense>; }
