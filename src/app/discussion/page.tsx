"use client";
import { useEffect, useRef, useState } from "react";
import PageHeader from "@/components/PageHeader";
import ChatMessageList, { ChatMessage } from "@/components/chat/ChatMessageList";
import ChatComposer from "@/components/chat/ChatComposer";
import { CHAT_SURFACE } from "@/lib/chat-theme";
import { useStudentData } from "@/lib/hooks/useStudentData";
import { ui } from "@/lib/student-ui";
import LoadFailed from "@/components/student/LoadFailed";
import { installAudioUnlock, playChime } from "@/lib/notification-sound";
const POLL_MS = 2000;

/**
 * Batch Discussion — the one student tab that never learned about admin
 * preview mode (item #72). Every fetch here used to read `sp_token` from
 * localStorage directly, so previewing ANY student's Discussion actually
 * showed the ADMIN's own real batch chat instead — live-reported as
 * "when I open the discussion of gnit 2 it is opening the gnitc 1". Now
 * shares `useStudentData()` with /batch, /payments and /messages, whose
 * `authHeader()` already prefers `preview_token` over the admin's own
 * session. Preview is also read-only here (no send, no read-receipts, no
 * call buttons) — the same "look, never act as the student" rule item
 * #72 applies everywhere else.
 */
export default function DiscussionPage() {
  const { router, previewMode, loading: studentLoading, loadError, reload, profile, groupChatEnabled, isRegisteredWithBatch, authHeader, navigate } = useStudentData();
  const myId: string | null = profile?.id ?? null;
  const batchId: string | null = profile?.batch_id ?? null;
  const batchName: string = profile?.batches?.name ?? "Your Batch";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (studentLoading) return;
    if (!isRegisteredWithBatch || !groupChatEnabled) { navigate("/dashboard"); return; }
    if (!batchId) return;
    loadMessages(batchId, true);
    pollTimer.current = setInterval(() => pollNew(batchId), POLL_MS);
    const onFocus = () => pollNew(batchId);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentLoading, isRegisteredWithBatch, groupChatEnabled, batchId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  // A soft sound for a message from someone else while this screen is open.
  // Never for your own messages, the first load, the "X just paid" notices, or
  // admin preview; playChime itself stays silent when sounds are switched off
  // (Profile) or the page is hidden (the phone's notification covers that).
  const heardRef = useRef<Set<string> | null>(null);
  const loadedOkRef = useRef(false); // true once the history has loaded; a failed first load takes no snapshot
  useEffect(() => { installAudioUnlock(); }, []);
  useEffect(() => {
    if (loading || !myId || !loadedOkRef.current) return;
    const confirmed = messages.filter(m => m._status !== "sending");
    if (heardRef.current === null) { heardRef.current = new Set(confirmed.map(m => m.id)); return; }
    const heard = heardRef.current;
    const fresh = confirmed.filter(m => !heard.has(m.id));
    if (!fresh.length) return;
    fresh.forEach(m => heard.add(m.id));
    if (!previewMode && fresh.some(m => m.sender_id !== myId && m.sender_role !== "system")) playChime();
  }, [messages, loading, myId, previewMode]);

  // The service worker says "a message just arrived" while this screen is open
  // (and mutes its own system alert, so only the pop below sounds): fetch now
  // instead of waiting out the 2s poll.
  useEffect(() => {
    if (!batchId || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => { if (e.data?.type === "sp_live" && e.data.liveOn === "/discussion") pollNew(batchId); };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  // Marking messages read is an action taken AS the student — skip it in preview.
  useEffect(() => {
    if (previewMode || !batchId || !myId || !messages.length) return;
    const ids = messages.filter(m => m.sender_id !== myId && m._status !== "sending").map(m => m.id);
    if (!ids.length) return;
    fetch(`/api/group-chat/${batchId}/read`, {
      method: "POST",
      headers: { ...authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: ids }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, batchId, myId, messages.length]);

  async function loadMessages(id: string, initial: boolean) {
    if (initial) setLoading(true);
    try {
      const res = await fetch(`/api/group-chat/${id}/messages`, { headers: authHeader() }).then(r => r.json());
      if (res.success) { loadedOkRef.current = true; setMessages(res.data ?? []); }
      else if (res.code === "UNAUTHORIZED" || res.code === "FORBIDDEN") setError(res.error ?? "You are not authorized to access this batch.");
    } finally {
      if (initial) setLoading(false);
    }
  }

  async function pollNew(id: string) {
    setMessages(prev => {
      const confirmed = prev.filter(m => m._status !== "sending");
      const since = confirmed.length ? confirmed[confirmed.length - 1].created_at : undefined;
      if (!since) return prev;
      fetch(`/api/group-chat/${id}/messages?since=${encodeURIComponent(since)}`, { headers: authHeader() })
        .then(r => r.json())
        .then(res => {
          if (res.success && res.data?.length) setMessages(cur => {
            const existing = new Set(cur.filter(m => m._status !== "sending").map(m => m.id));
            const fresh = (res.data as ChatMessage[]).filter(m => !existing.has(m.id));
            if (!fresh.length) return cur;
            const still = cur.filter(m => m._status === "sending" && !fresh.some(f => f.sender_id === m.sender_id && f.body === m.body));
            return [...cur.filter(m => m._status !== "sending"), ...fresh, ...still];
          });
        }).catch(() => {});
      return prev;
    });
  }

  function onPickAttachment(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setAttachment(f);
    setAttachmentPreview(f?.type.startsWith("image/") ? URL.createObjectURL(f) : null);
    e.target.value = "";
  }
  function clearAttachment() {
    if (attachmentPreview) URL.revokeObjectURL(attachmentPreview);
    setAttachment(null);
    setAttachmentPreview(null);
  }

  async function send() {
    if (previewMode || !batchId || !myId) return;
    const trimmed = text.trim();
    if (!trimmed && !attachment) return;
    setSending(true);
    setError(null);
    const sentAttachment = attachment;
    const tempId = `temp-${Date.now()}`;
    const optimisticBody = trimmed || (sentAttachment && !sentAttachment.type.startsWith("image/") ? `[Document] ${sentAttachment.name}` : null);
    setMessages(prev => [...prev, {
      id: tempId, sender_id: myId, sender_name: "You", sender_role: "student",
      body: optimisticBody, photo_url: sentAttachment?.type.startsWith("image/") ? attachmentPreview : null,
      created_at: new Date().toISOString(), _status: "sending", seen_count: 0,
    }]);
    setText("");
    clearAttachment();
    try {
      const fd = new FormData();
      if (trimmed) fd.append("body", trimmed);
      if (sentAttachment) fd.append("attachment", sentAttachment);
      const res = await fetch(`/api/group-chat/${batchId}/messages`, { method: "POST", headers: authHeader(), body: fd }).then(r => r.json());
      if (res.success) setMessages(prev => prev.map(m => m.id === tempId ? { ...res.data, _status: "sent" } : m));
      else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _status: "failed" } : m));
        setError(res.error ?? "Could not send. Please try again.");
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _status: "failed" } : m));
      setError("Network error. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <main style={{ height: "100dvh", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: ui.canvas, overscrollBehavior: "none" }}>
      {loadError && <LoadFailed onRetry={reload} />}
      <div style={{ flex: "0 0 auto", position: "relative", zIndex: 10 }}>
        <PageHeader
          title="Batch Discussion"
          subtitle={batchName}
          backHref="/dashboard"
          rightSlot={previewMode ? undefined : (
            <div className="flex gap-2 relative z-20 pointer-events-auto">
              <button type="button" onClick={(e) => { e.stopPropagation(); router.push("/discussion/call?mode=voice"); }} onTouchEnd={(e) => { e.stopPropagation(); }}
                aria-label="Start group voice call" title="Group voice call"
                className="w-11 h-11 rounded-full flex items-center justify-center active:scale-95 transition-transform pointer-events-auto touch-manipulation"
                style={{ border: `1px solid ${ui.border}`, background: ui.surface, color: ui.textPrimary, touchAction: "manipulation" }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.92z" /></svg>
              </button>
              <button type="button" onClick={(e) => { e.stopPropagation(); router.push("/discussion/call?mode=video"); }} onTouchEnd={(e) => { e.stopPropagation(); }}
                aria-label="Start group video call" title="Group video call"
                className="w-11 h-11 rounded-full flex items-center justify-center active:scale-95 transition-transform pointer-events-auto touch-manipulation"
                style={{ border: `1px solid ${ui.border}`, background: ui.surface, color: ui.textPrimary, touchAction: "manipulation" }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m23 7-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>
              </button>
            </div>
          )}
        />
      </div>
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", WebkitOverflowScrolling: "touch", overscrollBehavior: "contain", padding: "16px 12px 12px", width: "100%", ...CHAT_SURFACE }}>
        <div style={{ maxWidth: 480, margin: "0 auto" }}>
          {loading ? <p style={{ textAlign: "center", color: ui.textTertiary, fontSize: 13, marginTop: 40 }}>Loading…</p> : <ChatMessageList messages={messages} myId={myId} />}
          <div ref={bottomRef} />
        </div>
      </div>
      {error && <p style={{ flex: "0 0 auto", textAlign: "center", color: ui.danger, fontSize: 12, padding: "0 16px 6px", maxWidth: 480, margin: "0 auto" }}>{error}</p>}
      <div style={{ flex: "0 0 auto" }}>
        {previewMode ? (
          <div style={{ borderTop: `1px solid ${ui.border}`, background: ui.surface, padding: "12px 16px calc(env(safe-area-inset-bottom,0px) + 12px)", textAlign: "center" }}>
            <p style={{ fontSize: 12, color: ui.textTertiary, margin: 0 }}>Admin preview — read only</p>
          </div>
        ) : (
          <ChatComposer text={text} setText={setText} onSend={send} sending={sending} attachment={attachment} attachmentPreview={attachmentPreview} onPickAttachment={onPickAttachment} onClearAttachment={clearAttachment} placeholder="Message your batch…" />
        )}
      </div>
    </main>
  );
}
