"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";

interface Announcement {
  id: string;
  title: string;
  body: string;
  college: string;
  batch_id: string | null;
  priority: "normal" | "urgent";
  created_at: string;
  expires_at: string | null;
  attachment_url?: string | null;
  attachment_name?: string | null;
}

function isExpired(a: Announcement): boolean {
  return !!a.expires_at && new Date(a.expires_at) <= new Date();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function AttachmentButton({ url, name }: { url: string; name?: string | null }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 mt-2 bg-white/20 text-white text-xs font-semibold px-3 py-1.5 rounded-lg border border-white/30"
      onClick={e => e.stopPropagation()}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="12" y1="14" x2="12" y2="20"/><line x1="9" y1="17" x2="15" y2="17"/>
      </svg>
      {name ?? "Download Document"}
    </a>
  );
}

export default function AnnouncementHistoryPage() {
  const router = useRouter();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const h = () => ({ Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` });

  // ---- Seen tracking ---------------------------------------------------
  // When an announcement card actually scrolls into view on the student's
  // phone, report it once (batched, fire-and-forget) so the admin screen can
  // show real "seen by N" numbers.
  const seenIds = useRef<Set<string>>(new Set());
  const pendingIds = useRef<string[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardEls = useRef<Map<string, HTMLDivElement>>(new Map());

  function flushSeen() {
    const ids = pendingIds.current.splice(0);
    if (!ids.length) return;
    fetch("/api/announcements/seen", {
      method: "POST",
      headers: { ...h(), "Content-Type": "application/json" },
      body: JSON.stringify({ announcement_ids: ids }),
    }).catch(() => {});
  }

  function queueSeen(id: string) {
    if (seenIds.current.has(id)) return;
    seenIds.current.add(id);
    pendingIds.current.push(id);
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(flushSeen, 1500);
  }

  useEffect(() => {
    if (items.length === 0 || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = (e.target as HTMLElement).dataset.annId;
        if (id) queueSeen(id);
        io.unobserve(e.target);
      }
    }, { threshold: 0.4 });
    cardEls.current.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [items]);

  useEffect(() => {
    const t = localStorage.getItem("sp_token");
    if (!t) { router.replace("/register"); return; }
    fetch("/api/announcements?history=true", { headers: h() })
      .then(r => r.json())
      .then(j => {
        if (!j.success) { router.replace("/register"); return; }
        setItems(j.data ?? []);
        setLoading(false);
      })
      .catch(() => router.replace("/register"));
  }, []);

  const urgent = items.filter(a => a.priority === "urgent" && !isExpired(a));
  const rest   = items.filter(a => !(a.priority === "urgent" && !isExpired(a)));

  return (
    <main className="min-h-screen bg-gray-50 pb-10">
      <PageHeader
        title="Announcements"
        subtitle="Everything published for your batch, newest first"
        backHref="/dashboard"
        gradient="linear-gradient(135deg, #2563eb 0%, #1d4ed8 50%, #1e40af 100%)"
      />

      <div className="px-4 pt-5 space-y-3">
        {loading ? (
          [1, 2, 3].map(i => (
            <div key={i} className="bg-white rounded-2xl p-4 shadow-sm animate-pulse">
              <div className="h-3 bg-gray-100 rounded w-1/3 mb-3" />
              <div className="h-3 bg-gray-100 rounded w-full mb-2" />
              <div className="h-3 bg-gray-100 rounded w-2/3" />
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
            <div className="text-3xl mb-2">📭</div>
            <p className="text-sm font-bold text-gray-700">No announcements yet</p>
            <p className="text-xs text-gray-500 mt-1">
              Anything published for your batch will show up here.
            </p>
          </div>
        ) : (
          <>
            {urgent.map(a => (
              <div
                key={a.id}
                ref={el => { if (el) cardEls.current.set(a.id, el); else cardEls.current.delete(a.id); }}
                data-ann-id={a.id}
                className="rounded-2xl p-4"
                style={{ background: "#ef4444" }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  <p className="text-white font-extrabold text-sm">{a.title}</p>
                </div>
                <p className="text-white/85 text-xs leading-relaxed">{a.body}</p>
                {a.attachment_url && (
                  <AttachmentButton url={a.attachment_url} name={a.attachment_name} />
                )}
                <p className="text-white/60 text-[10px] mt-2">{formatDate(a.created_at)}</p>
              </div>
            ))}

            {rest.map(a => {
              const expired = isExpired(a);
              return (
                <div
                  key={a.id}
                  ref={el => { if (el) cardEls.current.set(a.id, el); else cardEls.current.delete(a.id); }}
                  data-ann-id={a.id}
                  className="bg-white rounded-2xl p-4 shadow-sm"
                  style={{ borderLeft: `3px solid ${expired ? "#d1d5db" : "#1d4ed8"}` }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className={`font-extrabold text-sm ${expired ? "text-gray-500" : "text-gray-900"}`}>
                      {a.title}
                    </p>
                    {expired && (
                      <span className="flex-shrink-0 text-[10px] font-bold text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">
                        Past
                      </span>
                    )}
                  </div>
                  <p className={`text-xs mt-1 leading-relaxed ${expired ? "text-gray-500" : "text-gray-600"}`}>
                    {a.body}
                  </p>
                  {a.attachment_url && !expired && (
                    <a
                      href={a.attachment_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 mt-2 bg-blue-50 text-blue-600 text-xs font-semibold px-3 py-1.5 rounded-lg"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="14" x2="12" y2="20"/><line x1="9" y1="17" x2="15" y2="17"/>
                      </svg>
                      {a.attachment_name ?? "Download Document"}
                    </a>
                  )}
                  <p className="text-[10px] text-gray-500 mt-2">{formatDate(a.created_at)}</p>
                </div>
              );
            })}
          </>
        )}
      </div>
    </main>
  );
}
