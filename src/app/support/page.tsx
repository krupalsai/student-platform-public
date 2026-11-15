"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock, Headset, Menu, MessageCircle, MessageSquareReply, Paperclip, RotateCw, Send, X } from "lucide-react";
import { SUPPORT_MENU_TOPICS } from "@/lib/support-menu";
import { ACCEPT_ATTR, IMAGE_TYPE_ERROR, ALLOWED_IMAGE_MIME } from "@/lib/image-types";
import { ui } from "@/lib/student-ui";
import { installAudioUnlock, playChime } from "@/lib/notification-sound";

type Thread = {
  id: string;
  message: string;
  category: string;
  priority: string;
  status: string;
  created_at: string;
  last_message_at: string | null;
  last_sender: string | null;
  resolved_at: string | null;
  escalated_at?: string | null;
  admin_responded_at?: string | null;
};

type MessageMeta = { action?: { label: string; href: string }; retryable?: boolean; escalated?: boolean } | null;
type Message = { id: string; query_id: string; sender: "student" | "admin" | "bot"; body: string; photo_url: string | null; meta?: MessageMeta; created_at: string };

/** Only in-app paths the server's ACTIONS map can produce — never an arbitrary URL. */
const SAFE_ACTION = /^\/(payments|batch|messages|profile|correction|register|discussion)$/;

const CASE_BANNER: Record<string, { text: string; tone: "wait" | "done" }> = {
  pending_admin: { text: "Sent to the support team — their reply will appear here.", tone: "wait" },
  answered: { text: "The support team replied below.", tone: "done" },
};

function sessionHeaders(): HeadersInit {
  const token = localStorage.getItem("sp_token")?.trim() ?? "";
  return token
    ? { Authorization: `Bearer ${token}`, "x-session-token": token }
    : {};
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

/**
 * Markdown-lite for assistant/support-team bubbles: bot replies are authored
 * with **bold** markers, which look broken as literal asterisks. HTML is
 * escaped first (these bodies are system/AI-generated, never raw user input),
 * then **bold** becomes <strong> and newlines become <br/>. Student bubbles
 * stay plain text.
 */
function renderRich(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br/>");
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}

/**
 * A single continuous chat with the AI support assistant — iMessage-style
 * bubbles, one composer, no ticket-form chrome. Always resumes the
 * student's latest OPEN thread; if none is open, the next message
 * silently starts one (`POST` vs `PUT` on the same `/api/support`
 * backend, which auto-replies as `sender: "bot"` on every message — see
 * `src/lib/services/support-bot.ts`).
 *
 * Every API response here has the shape `{ success, data }` or
 * `{ success: false, error }` (see `src/lib/api-response.ts`'s `ok()`) —
 * checking `json.ok` (which never exists) instead of `json.success` was a
 * real bug in an earlier version of this page: every genuinely successful
 * load/send was misread as a failure, which is why "Could not load
 * support." / "Could not send your message." showed up even when the
 * server logs showed a clean 200. Always check `.success`.
 */
function currentToken(): string {
  return localStorage.getItem("sp_token")?.trim() ?? "";
}

export default function SupportPage() {
  const router = useRouter();
  const [thread, setThread] = useState<Thread | null>(null);
  const [allThreads, setAllThreads] = useState<Thread[]>([]);
  const [allMessages, setAllMessages] = useState<Message[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [message, setMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Which session token the currently-rendered thread/messages belong to.
  // A device that switches accounts without this page ever unmounting
  // (a backgrounded tab resumed after signing in as someone else, or a
  // browser/router restoring a previously-rendered instance of this page)
  // would otherwise keep showing the PREVIOUS account's chat, with a new
  // send landing on top of it — read live as "what I sent is seen in
  // someone [else's] chat." Every re-check below compares against this.
  const loadedTokenRef = useRef<string>("");
  const threadIdRef = useRef<string | null>(null);
  // Ids of the replies (assistant or team) already on this device, so only a
  // NEW one makes a sound. null until the first load, which stays silent.
  const heardRef = useRef<Set<string> | null>(null);

  async function load() {
    const token = currentToken();
    try {
      const res = await fetch("/api/support", { cache: "no-store", headers: sessionHeaders() });
      const json = await res.json();
      if (!res.ok || !json.success) {
        if (res.status === 403) throw new Error("Your session has expired. Please sign in again.");
        throw new Error(json.error ?? "Could not load support.");
      }
      const threads: Thread[] = json.data?.threads ?? [];
      const all: Message[] = json.data?.messages ?? [];
      // A soft sound when a reply arrives while this screen is open — the
      // assistant's answer or the team's reply, on any of the student's
      // conversations (`all` holds every thread, so switching the thread on
      // screen is not a new reply). Never for the student's own messages, and
      // the first SUCCESSFUL load only takes a snapshot, so a failed first load
      // followed by "Try again" can't read the whole history as new.
      const incoming = all.filter((m) => m.sender !== "student").map((m) => m.id);
      if (heardRef.current === null) {
        heardRef.current = new Set(incoming);
      } else {
        const heard = heardRef.current;
        const fresh = incoming.filter((id) => !heard.has(id));
        if (fresh.length) { fresh.forEach((id) => heard.add(id)); playChime(); }
      }
      setAllThreads(threads);
      setAllMessages(all);
      // Keep showing the thread the student is looking at (e.g. after a send
      // or a team reply); otherwise resume the latest one that isn't closed.
      const keep = threadIdRef.current ? threads.find((t) => t.id === threadIdRef.current) : null;
      const latest = keep ?? threads.find((t) => t.status !== "resolved") ?? threads[0] ?? null;
      threadIdRef.current = latest?.id ?? null;
      setThread(latest);
      setMessages(latest ? all.filter((m) => m.query_id === latest.id) : []);
      setError("");
      loadedTokenRef.current = token;
    } catch (e: any) {
      setError(e?.message ?? "Could not load support.");
    } finally {
      setLoading(false);
    }
  }

  /** If the active session token has changed since the last load — a
   * different account signed in on this same tab/device without this
   * page remounting — drop whatever's on screen and reload fresh rather
   * than risk rendering (or sending into) the wrong account's thread. */
  function resyncIfAccountChanged() {
    const token = currentToken();
    if (token === loadedTokenRef.current) return;
    heardRef.current = null; // the other account's history must not sound like new replies
    setThread(null);
    threadIdRef.current = null;
    setMessages([]);
    setError("");
    setLoading(true);
    void load();
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    window.addEventListener("focus", resyncIfAccountChanged);
    document.addEventListener("visibilitychange", resyncIfAccountChanged);
    window.addEventListener("storage", resyncIfAccountChanged);
    return () => {
      window.removeEventListener("focus", resyncIfAccountChanged);
      document.removeEventListener("visibilitychange", resyncIfAccountChanged);
      window.removeEventListener("storage", resyncIfAccountChanged);
    };
  }, []);

  // While a case is with the team, check for their reply every 20s so it
  // shows up without the student having to leave and come back.
  const waitingOnTeam = thread?.status === "pending_admin";
  useEffect(() => {
    if (!waitingOnTeam) return;
    const t = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingOnTeam]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => { installAudioUnlock(); }, []);

  // The service worker says "the team just replied" while this screen is open
  // (and mutes its own system alert, so only the pop sounds): load now instead
  // of waiting for the 20s check.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => { if (e.data?.type === "sp_live" && e.data.liveOn === "/support") void load(); };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Other conversations the student has had with the team (for switching). */
  const otherCases = useMemo(
    () => allThreads.filter((t) => t.id !== thread?.id && (t.status === "pending_admin" || t.status === "answered" || t.escalated_at)),
    [allThreads, thread],
  );

  function openThread(t: Thread) {
    threadIdRef.current = t.id;
    setThread(t);
    setMessages(allMessages.filter((m) => m.query_id === t.id));
  }

  function startNew() {
    threadIdRef.current = null;
    setThread(null);
    setMessages([]);
  }

  async function retryLast() {
    if (!thread) return;
    setRetrying(true);
    setError("");
    try {
      const res = await fetch("/api/support", {
        method: "PUT",
        headers: { ...sessionHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ queryId: thread.id, retry: true }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Could not retry. Please try again.");
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Could not retry.");
    } finally {
      setRetrying(false);
    }
  }

  const grouped = useMemo(() => {
    const out: { day: string; items: Message[] }[] = [];
    for (const m of messages) {
      const day = dayLabel(m.created_at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(m);
      else out.push({ day, items: [m] });
    }
    return out;
  }, [messages]);

  function onPickPhoto(file: File | null) {
    if (!file) { setPhoto(null); setPhotoPreview(null); return; }
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type)) {
      setError(IMAGE_TYPE_ERROR);
      return;
    }
    setError("");
    setPhoto(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  function clearPhoto() {
    setPhoto(null);
    setPhotoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /** A menu tap sends the topic label as the message; the server answers it from data. */
  function sendTopic(topic: string) {
    setMenuOpen(false);
    if (sending) return;
    void submit(undefined, topic);
  }

  async function submit(e?: FormEvent, topic?: string) {
    e?.preventDefault();
    if (!topic && !message.trim() && !photo) return;
    setSending(true);
    setError("");

    const optimisticText = topic ?? message.trim();
    const attachedPhoto = topic ? null : photo;
    const typedDraft = message;
    if (!topic) {
      setMessage("");
      clearPhoto();
    }
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Render the tapped/typed message instantly. Without this, a topic tap
    // shows nothing until the whole server round trip (including AI reply
    // generation) finishes — the tap looks dead and the query only "appears
    // later". load() below replaces this temp copy with the server one.
    const optimisticId = `temp-${Date.now()}`;
    setMessages((prev) => [...prev, {
      id: optimisticId,
      query_id: thread?.id ?? "temp",
      sender: "student",
      body: optimisticText,
      photo_url: photoPreview,
      created_at: new Date().toISOString(),
    }]);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });

    try {
      let photoUrl: string | undefined;
      let photoDescription: string | undefined;

      if (attachedPhoto) {
        try {
          const form = new FormData();
          form.append("file", attachedPhoto);
          const res = await fetch("/api/support/image-describe", { method: "POST", headers: sessionHeaders(), body: form });
          const j = await res.json();
          if (res.ok && j.success && j.data?.url) {
            photoUrl = j.data.url;
            photoDescription = j.data.description ?? undefined;
          } else {
            throw new Error(j.error ?? "Could not upload photo");
          }
        } catch (photoErr: any) {
          setError(photoErr?.message ?? "Could not process that photo. Try sending it again.");
          setSending(false);
          setMessage(optimisticText);
          return;
        }
      }

      // A follow-up goes into the thread on screen; a closed thread (or none)
      // starts a new conversation.
      const method = thread && thread.status !== "resolved" ? "PUT" : "POST";
      const body: Record<string, unknown> = method === "PUT" ? { queryId: thread!.id, message: optimisticText } : { message: optimisticText };
      if (photoUrl) { body.photoUrl = photoUrl; body.photoDescription = photoDescription; }

      const res = await fetch("/api/support", {
        method,
        headers: { ...sessionHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        if (res.status === 403) throw new Error("Your session has expired. Please sign in again.");
        throw new Error(json.error ?? "Could not send your message.");
      }
      if (json.data?.id) threadIdRef.current = json.data.id;
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Could not send your message.");
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setMessage(topic ? typedDraft : optimisticText);
    } finally {
      setSending(false);
    }
  }

  return (
    <main style={{ height: "100dvh", minHeight: 0, background: ui.canvas }} className="flex flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${ui.border}`, background: ui.surface }}>
        <Link href="/dashboard" style={{ color: ui.accent }} aria-label="Back">
          <ChevronLeft size={24} strokeWidth={2.2} />
        </Link>
        <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "#e9e9eb" }}>
          <Headset size={19} strokeWidth={1.8} style={{ color: ui.textSecondary }} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold" style={{ color: ui.textPrimary }}>Support</h1>
          <p className="text-[11px]" style={{ color: ui.textTertiary }}>Call first for hands-free help</p>
        </div>
        {thread && thread.status !== "open" && (
          <button type="button" onClick={startNew} className="rounded-full px-3 py-1.5 text-[12px] font-semibold" style={{ background: "#ffffff", color: ui.accent, border: `1px solid ${ui.border}` }}>
            New question
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
        <section className="mx-auto mb-5 max-w-2xl rounded-2xl p-4" style={{ background: ui.surface, border: `1px solid ${ui.border}` }}>
          <details>
            <summary className="cursor-pointer text-[15px] font-bold" style={{ color: ui.textPrimary }}>Stuck? Fix it in 2 minutes</summary>
            <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: ui.textSecondary }}>OTP not coming, “number not registered”, or still stuck? This photo fixes the 3 most common problems — follow the box that matches yours.</p>
            <img src="/api/help/fix-guide" alt="Stuck? Fix it in 2 minutes — how to fix a missing OTP, a number not registered, and how to clear site data" className="mt-3 w-full rounded-xl" />
          </details>
        </section>
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm" style={{ color: ui.textTertiary }}>Loading…</div>
        ) : messages.length === 0 && !error ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-2 px-2 py-4 text-center">
            <div className="flex h-[84px] w-[84px] items-center justify-center rounded-full" style={{ background: "#e9e9eb" }}>
              <MessageCircle size={38} strokeWidth={1.5} style={{ color: ui.textTertiary }} />
            </div>
            <p className="mt-2 text-[20px] font-bold tracking-tight" style={{ color: ui.textPrimary }}>How can we help?</p>
            <p className="max-w-xs text-[13px] leading-relaxed" style={{ color: ui.textSecondary }}>
              Tap a topic for an instant answer from your own records — or just type your question below.
            </p>
            <TopicList onPick={sendTopic} disabled={sending} />
          </div>
        ) : messages.length === 0 && error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-sm font-semibold" style={{ color: ui.danger }}>{error}</p>
            <button
              onClick={() => { setLoading(true); void load(); }}
              className="rounded-full px-4 py-2 text-xs font-semibold text-white"
              style={{ background: ui.accent }}
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-1">
            {otherCases.length > 0 && (
              <div className="mb-3 rounded-2xl p-2" style={{ background: ui.surface, border: `1px solid ${ui.border}` }}>
                <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: ui.textTertiary }}>Your other requests</p>
                {otherCases.slice(0, 4).map((t) => (
                  <button key={t.id} type="button" onClick={() => openThread(t)}
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left">
                    {t.status === "pending_admin"
                      ? <Clock size={14} style={{ color: ui.warning }} />
                      : <MessageSquareReply size={14} style={{ color: ui.success }} />}
                    <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: ui.textPrimary }}>{t.message}</span>
                    <span className="text-[11px]" style={{ color: t.status === "pending_admin" ? ui.warning : ui.textTertiary }}>
                      {t.status === "pending_admin" ? "Pending" : t.status === "answered" ? "Answered" : t.status === "resolved" ? "Closed" : "Open"}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {thread && CASE_BANNER[thread.status] && (
              <div className="mb-3 flex items-center gap-2 rounded-2xl px-3 py-2.5 text-[12.5px]"
                style={CASE_BANNER[thread.status].tone === "wait"
                  ? { background: ui.warningSoft, border: `1px solid ${ui.warningSoftBorder}`, color: ui.textPrimary }
                  : { background: ui.surface, border: `1px solid ${ui.border}`, color: ui.textPrimary }}>
                {CASE_BANNER[thread.status].tone === "wait" ? <Clock size={15} style={{ color: ui.warning }} /> : <MessageSquareReply size={15} style={{ color: ui.success }} />}
                <span className="flex-1">{CASE_BANNER[thread.status].text}</span>
              </div>
            )}
            {thread?.status === "resolved" && (
              <div className="mb-3 rounded-2xl px-3 py-2.5 text-center text-[12.5px]" style={{ background: ui.surface, border: `1px solid ${ui.border}`, color: ui.textSecondary }}>
                This conversation is closed. Sending a new message starts a new one.
              </div>
            )}
            {(() => {
              const lastTeamReplyAt = messages.reduce(
                (mx: number, x: Message) => (x.sender !== "student" ? Math.max(mx, new Date(x.created_at).getTime()) : mx),
                0,
              );
              return grouped.map((g) => (
              <div key={g.day}>
                <div className="my-3 flex items-center justify-center">
                  <span className="rounded-full px-3 py-1 text-[11px] font-medium" style={{ background: ui.surface, color: ui.textTertiary, border: `1px solid ${ui.border}` }}>{g.day}</span>
                </div>
                {g.items.map((m, mi) => {
                  const mine = m.sender === "student";
                  const groupedNext = g.items[mi + 1]?.sender === m.sender;
                  const seen = mine && lastTeamReplyAt > new Date(m.created_at).getTime();
                  const bubbleStyle = mine
                    ? { background: ui.accent, color: "#fff" }
                    : { background: "#e9e9eb", color: ui.textPrimary };
                  const tail = groupedNext ? "" : mine ? "rounded-br-md" : "rounded-bl-md";
                  return (
                    <div key={m.id} className={`${groupedNext ? "mb-0.5" : "mb-2"} flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${tail}`}
                        style={bubbleStyle}
                      >
                        {m.photo_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.photo_url} alt="Attached" className="mb-1.5 max-h-64 w-full rounded-xl object-cover" />
                        )}
                        {m.body && m.body !== "📷 Photo" && (
                          mine
                            ? <div className="whitespace-pre-line">{m.body}</div>
                            : <div dangerouslySetInnerHTML={{ __html: renderRich(m.body) }} />
                        )}
                        {m.sender === "bot" && m.meta?.action && SAFE_ACTION.test(m.meta.action.href) && (
                          <button
                            type="button"
                            onClick={() => router.push(m.meta!.action!.href)}
                            className="mt-2 flex w-full items-center justify-between rounded-xl px-3 py-2 text-[13px] font-semibold"
                            style={{ background: "#ffffff", color: ui.accent, border: `1px solid ${ui.border}` }}
                          >
                            {m.meta.action.label} <ChevronRight size={15} />
                          </button>
                        )}
                        {m.sender === "bot" && m.meta?.retryable && m.id === messages[messages.length - 1]?.id && (
                          <button
                            type="button"
                            onClick={retryLast}
                            disabled={retrying}
                            className="mt-2 flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-semibold disabled:opacity-50"
                            style={{ background: "#ffffff", color: ui.accent, border: `1px solid ${ui.border}` }}
                          >
                            <RotateCw size={14} className={retrying ? "animate-spin" : ""} /> {retrying ? "Trying…" : "Try again"}
                          </button>
                        )}
                        <div className="mt-1 flex items-center justify-end gap-1 text-[10px]" style={{ color: mine ? "rgba(255,255,255,0.92)" : ui.textSecondary }}>
                          <span>{timeOf(m.created_at)}</span>
                          {mine && <span style={{ color: seen ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.5)" }}>{seen ? "✓✓" : "✓"}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))})()}
            {sending && (
              <div className="mb-2 flex justify-start">
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md px-4 py-3" style={{ background: "#e9e9eb" }}>
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:-0.3s]" style={{ background: ui.textTertiary }} />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:-0.15s]" style={{ background: ui.textTertiary }} />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full" style={{ background: ui.textTertiary }} />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <form onSubmit={submit} className="shrink-0 px-3 py-2.5 sm:px-6" style={{ borderTop: `1px solid ${ui.border}`, background: ui.surface, paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom,0px))" }}>
        <div className="mx-auto max-w-2xl">
          {messages.some((m) => m.sender === "student") && (
            <p className="mb-2 text-xs" style={{ color: ui.textSecondary }}>Tap + for quick answers, or type your question.</p>
          )}
          {error && messages.length > 0 && <p className="mb-1.5 text-xs" style={{ color: ui.danger }}>{error}</p>}
          {menuOpen && (
            <div className="mb-2 max-h-[45vh] overflow-y-auto rounded-2xl p-3" style={{ border: `1px solid ${ui.border}`, background: ui.surface }}>
              <TopicList onPick={sendTopic} disabled={sending} />
            </div>
          )}
          {photoPreview && (
            <div className="mb-2 flex items-center gap-2 rounded-xl p-2" style={{ border: `1px solid ${ui.border}`, background: ui.canvas }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoPreview} alt="Attached" className="h-12 w-12 rounded-lg object-cover" />
              <span className="flex-1 truncate text-xs" style={{ color: ui.textSecondary }}>{photo?.name}</span>
              <button type="button" onClick={clearPhoto} className="rounded-full p-1" style={{ color: ui.textTertiary }} aria-label="Remove photo">
                <X size={16} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
              style={{ color: ui.textTertiary }}
            >
              {menuOpen ? <X size={19} strokeWidth={2} /> : <Menu size={19} strokeWidth={2} />}
            </button>
            <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} className="hidden" onChange={(e) => onPickPhoto(e.target.files?.[0] ?? null)} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach a photo"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
              style={{ color: ui.textTertiary }}
            >
              <Paperclip size={20} strokeWidth={1.8} />
            </button>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(e as any); }
              }}
              placeholder="Type a message"
              rows={1}
              className="max-h-[120px] flex-1 resize-none rounded-3xl px-4 py-2.5 text-sm outline-none"
              style={{ border: `1px solid ${ui.border}`, background: ui.canvas, color: ui.textPrimary }}
            />
            <button
              disabled={sending || (!message.trim() && !photo)}
              aria-label="Send"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: ui.accent }}
            >
              <Send size={18} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </form>
    </main>
  );
}

/** The Support menu (support-menu.ts) — each tap is answered instantly from the student's own data. */
function TopicList({ onPick, disabled }: { onPick: (topic: string) => void; disabled: boolean }) {
  return (
    <div className="mt-3 flex w-full max-w-sm flex-wrap justify-center gap-2">
      {SUPPORT_MENU_TOPICS.map((t) => (
        <button
          key={t}
          type="button"
          disabled={disabled}
          onClick={() => onPick(t)}
          className="rounded-full px-4 py-2 text-[13.5px] font-medium disabled:opacity-50"
          style={{ background: ui.surface, color: ui.accent, border: `1px solid ${ui.border}` }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
