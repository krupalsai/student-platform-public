"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { RotateCw, CheckCircle2, LifeBuoy, ChevronLeft } from "lucide-react";

/**
 * Support Inbox — in-app conversations the Student App assistant could not
 * answer. Replying here writes into the student's own thread (they read it in
 * the app) and notifies them. Answers given here are NOT turned into FAQs;
 * a reusable answer still belongs in /admin/questions.
 */

interface Thread {
  id: string;
  message: string;
  status: string;
  created_at: string;
  last_message_at: string | null;
  escalated_at: string | null;
  college: string | null;
  profiles: { full_name: string | null; phone: string | null; batches: { name: string } | null } | null;
}
interface Msg { id: string; sender: string; body: string; photo_url: string | null; created_at: string }
interface History {
  otherThreads: { id: string; status: string; created_at: string; messages: { sender: string; body: string; photo_url: string | null; created_at: string }[] }[];
  whatsapp: { sender: string; body: string; at: string | null }[];
  questions: { id: string; question: string; status: string; occurrence_count: number | null; first_seen_at: string; answered_at: string | null }[];
}

/** Exact date and time in IST, so the team can see what happened when. */
function stamp(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function Bubble({ sender, body, photo, at }: { sender: string; body: string; photo?: string | null; at: string | null }) {
  const student = sender === "student";
  const label = student ? "Student" : sender === "bot" ? "Bot" : "Team";
  const bg = sender === "admin" ? "#0e7490" : sender === "bot" ? "#eef2f7" : "#fff";
  return (
    <div style={{ alignSelf: student ? "flex-start" : "flex-end", maxWidth: "85%" }}>
      <p style={{ margin: "0 4px 2px", fontSize: 10, fontWeight: 700, color: "#9ca3af" }}>{label} · {stamp(at)}</p>
      <div style={{ background: bg, color: sender === "admin" ? "#fff" : "#111827", borderRadius: 14, padding: "9px 12px", fontSize: 13, lineHeight: 1.45, whiteSpace: "pre-wrap", boxShadow: "0 1px 3px rgba(0,0,0,0.05)", border: student ? "1px solid #e5e7eb" : "none" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {photo && <img src={photo} alt="Attached" style={{ maxWidth: "100%", borderRadius: 10, marginBottom: body ? 6 : 0 }} />}
        {body}
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: "#fff", borderRadius: 14, marginBottom: 10, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
      <button onClick={() => setOpen(!open)} disabled={count === 0}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", background: "none", border: "none", padding: "12px 14px", fontSize: 13, fontWeight: 700, color: count ? "#111827" : "#9ca3af", cursor: count ? "pointer" : "default" }}>
        <span>{title}</span><span>{count === 0 ? "None" : open ? "Hide" : `${count} · Show`}</span>
      </button>
      {open && count > 0 && <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>}
    </div>
  );
}

const TABS: { key: string; label: string }[] = [
  { key: "pending_admin", label: "Waiting" },
  { key: "answered", label: "Answered" },
  { key: "open", label: "With assistant" },
  { key: "resolved", label: "Closed" },
];

const STATUS_LABEL: Record<string, string> = {
  pending_admin: "Waiting for team", answered: "Team replied", open: "Assistant handling", resolved: "Closed",
};

function timeAgo(iso: string | null) {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

export default function SupportInboxPage() {
  const router = useRouter();
  const [tab, setTab] = useState("pending_admin");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [threadInfo, setThreadInfo] = useState<Thread | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [threadState, setThreadState] = useState<"loading" | "ready" | "error">("loading");
  const [threadError, setThreadError] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  function load(t = tab) {
    setLoading(true); setError("");
    fetch(`/api/admin/support?status=${t}`, { headers: h(), cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) { setError(j.error ?? "Failed to load"); return; }
        setThreads(j.data.threads ?? []); setPending(j.data.pending ?? 0);
      })
      .catch(() => setError("Network error — check your connection."))
      .finally(() => setLoading(false));
  }

  function openThread(id: string) {
    // Keep what is already on screen when refreshing the same thread; only a
    // different thread starts from a blank, clearly-loading state.
    if (id !== openId) { setMsgs([]); setThreadInfo(null); setHistory(null); setReply(""); setThreadState("loading"); }
    setOpenId(id); setThreadError("");
    fetch(`/api/admin/support/${id}`, { headers: h(), cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j.success) { setMsgs(j.data.messages ?? []); setThreadInfo(j.data.thread); setHistory(j.data.history ?? null); setThreadState("ready"); }
        else { setThreadError(j.error ?? "Could not load this conversation."); setThreadState("error"); }
      })
      .catch(() => { setThreadError("Network error — check your connection."); setThreadState("error"); });
  }

  async function send(resolve: boolean) {
    if (!openId) return;
    if (!reply.trim() && !resolve) { setToast("Type a reply first."); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/support/${openId}`, {
        method: "POST", headers: { ...h(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: reply.trim(), resolve }),
      });
      const j = await res.json();
      if (!j.success) { setToast(j.error ?? "Failed"); return; }
      setToast(reply.trim() ? "Reply sent — the student was notified" : "Conversation closed");
      setReply("");
      openThread(openId);
      load();
    } catch { setToast("Network error"); } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!localStorage.getItem("sp_token")) { router.replace("/"); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const head = (
    <div style={{ background: "linear-gradient(135deg,#0e7490,#155e75)", padding: "48px 16px 18px" }}>
      <button onClick={() => (openId ? setOpenId(null) : router.back())}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.15)", border: "1.5px solid rgba(255,255,255,0.25)", borderRadius: 14, padding: "8px 14px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: 14 }}>
        <ChevronLeft size={15} /> {openId ? "Inbox" : "Back"}
      </button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ color: "#fff", fontSize: 20, fontWeight: 700, margin: 0 }}>Support Inbox</h1>
          <p style={{ color: "rgba(255,255,255,0.8)", fontSize: 12, margin: "4px 0 0" }}>
            {pending} waiting · replies appear in the student&apos;s app chat
          </p>
        </div>
        <button onClick={() => (openId ? openThread(openId) : load())} aria-label="Refresh"
          style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 12, padding: "8px 12px", color: "#fff", cursor: "pointer" }}><RotateCw size={16} /></button>
      </div>
    </div>
  );

  if (openId) {
    const listRow = threads.find((t) => t.id === openId) ?? null;
    const info = threadInfo ?? listRow;
    const who = info?.profiles;
    return (
      <div style={{ minHeight: "100vh", background: "#f8f9fa", paddingBottom: 220 }}>
        {head}
        <div style={{ padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 14, padding: "12px 14px", marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>{who?.full_name ?? "Student"}</p>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
              {[info?.college, who?.batches?.name, who?.phone, STATUS_LABEL[info?.status ?? ""] ?? info?.status].filter(Boolean).join(" · ")}
            </p>
          </div>
          {history && (
            <div style={{ marginBottom: 6 }}>
              <p style={{ margin: "0 2px 8px", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 }}>His other history</p>
              <Section title="Questions sent to the team" count={history.questions.length}>
                {history.questions.map((q) => (
                  <div key={q.id} style={{ fontSize: 13, color: "#111827", borderBottom: "1px solid #f1f5f9", paddingBottom: 6 }}>
                    {q.question}
                    <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                      {stamp(q.first_seen_at)}{(q.occurrence_count ?? 1) > 1 ? ` · asked ${q.occurrence_count}×` : ""} · {q.status === "answered" ? `answered ${stamp(q.answered_at)}` : q.status}
                    </div>
                  </div>
                ))}
              </Section>
              <Section title="WhatsApp chat with the bot" count={history.whatsapp.length}>
                {history.whatsapp.map((m, i) => <Bubble key={i} sender={m.sender} body={m.body} at={m.at} />)}
              </Section>
              <Section title="Earlier app conversations" count={history.otherThreads.length}>
                {history.otherThreads.map((t) => (
                  <div key={t.id} style={{ display: "flex", flexDirection: "column", gap: 8, borderBottom: "1px solid #f1f5f9", paddingBottom: 10 }}>
                    <p style={{ margin: 0, fontSize: 11, fontWeight: 700, color: "#6b7280" }}>Started {stamp(t.created_at)} · {STATUS_LABEL[t.status] ?? t.status}</p>
                    {t.messages.map((m, i) => <Bubble key={i} sender={m.sender} body={m.body} photo={m.photo_url} at={m.created_at} />)}
                  </div>
                ))}
              </Section>
              <p style={{ margin: "14px 2px 8px", fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 }}>This conversation · {msgs.length} messages</p>
            </div>
          )}
          {threadState === "loading" && msgs.length === 0 && (
            <p style={{ textAlign: "center", color: "#9ca3af", padding: "32px 0", fontSize: 14 }}>Loading conversation…</p>
          )}
          {threadState === "error" && (
            <div style={{ background: "#fee2e2", borderRadius: 14, padding: "12px 16px", color: "#dc2626", fontSize: 13, marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span>{threadError}</span>
              <button onClick={() => openThread(openId)} style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 10, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Retry</button>
            </div>
          )}
          {threadState === "ready" && msgs.length === 0 && (
            <p style={{ textAlign: "center", color: "#9ca3af", padding: "32px 0", fontSize: 14 }}>No messages in this conversation.</p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {msgs.map((m) => <Bubble key={m.id} sender={m.sender} body={m.body} photo={m.photo_url} at={m.created_at} />)}
          </div>
        </div>
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, background: "#fff", borderTop: "1px solid #e5e7eb", padding: "12px 16px calc(12px + env(safe-area-inset-bottom))" }}>
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} maxLength={2000}
            placeholder="Reply to the student — they'll see it in the app and get a notification."
            style={{ width: "100%", boxSizing: "border-box", border: "1.5px solid #e5e7eb", borderRadius: 12, padding: "10px 12px", fontSize: 13, fontFamily: "inherit", resize: "none", outline: "none" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={() => send(false)} disabled={busy || threadState !== "ready"}
              style={{ flex: 2, background: busy ? "#94a3b8" : "#0e7490", color: "#fff", border: "none", borderRadius: 12, padding: "12px 0", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
              {busy ? "Sending…" : "Send reply"}
            </button>
            <button onClick={() => send(true)} disabled={busy || threadState !== "ready"}
              style={{ flex: 1, background: "#f1f5f9", color: "#0f172a", border: "none", borderRadius: 12, padding: "12px 0", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
              {reply.trim() ? "Send & close" : "Close"}
            </button>
          </div>
        </div>
        {toast && <Toast text={toast} onClose={() => setToast("")} />}
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f8f9fa", paddingBottom: 60 }}>
      {head}
      <div style={{ display: "flex", gap: 8, padding: "14px 16px 0", overflowX: "auto" }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => { setTab(t.key); load(t.key); }}
            style={{ flexShrink: 0, padding: "7px 14px", borderRadius: 999, border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer", background: tab === t.key ? "#0e7490" : "#e5e7eb", color: tab === t.key ? "#fff" : "#374151" }}>
            {t.label}{t.key === "pending_admin" && pending ? ` (${pending})` : ""}
          </button>
        ))}
      </div>
      <div style={{ padding: 16 }}>
        {error && <div style={{ background: "#fee2e2", borderRadius: 14, padding: "12px 16px", color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        {loading ? (
          <p style={{ textAlign: "center", color: "#9ca3af", padding: "40px 0", fontSize: 14 }}>Loading…</p>
        ) : threads.length === 0 ? (
          <div style={{ textAlign: "center", padding: "56px 16px" }}>
            <CheckCircle2 size={34} strokeWidth={1.6} color="#a5f3fc" style={{ marginBottom: 8 }} />
            <p style={{ fontSize: 15, fontWeight: 700, color: "#111827", margin: 0 }}>Nothing here</p>
            <p style={{ fontSize: 13, color: "#9ca3af", margin: "4px 0 0" }}>No conversations in this list.</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {threads.map((t) => (
              <button key={t.id} onClick={() => openThread(t.id)}
                style={{ textAlign: "left", background: "#fff", border: "none", borderRadius: 16, padding: "14px", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", cursor: "pointer", display: "flex", gap: 10 }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, background: "#cffafe", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><LifeBuoy size={16} color="#0e7490" /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: "#111827" }}>{t.profiles?.full_name ?? "Student"}</span>
                  <span style={{ display: "block", fontSize: 13, color: "#374151", margin: "2px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.message}</span>
                  <span style={{ display: "block", fontSize: 11, color: "#9ca3af" }}>
                    {[t.college, t.profiles?.batches?.name].filter(Boolean).join(" · ")} · {timeAgo(t.last_message_at ?? t.created_at)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {toast && <Toast text={toast} onClose={() => setToast("")} />}
    </div>
  );
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div onClick={onClose}
      style={{ position: "fixed", left: 16, right: 16, bottom: 160, background: "#111827", color: "#fff", borderRadius: 14, padding: "13px 16px", fontSize: 13, fontWeight: 600, zIndex: 80, cursor: "pointer" }}>
      {text}
    </div>
  );
}
