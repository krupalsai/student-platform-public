"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";

interface NewsItem {
  id: string;
  batch_slug: string;
  college: string;
  batch_name: string;
  title: string;
  body: string;
  event_type: "filing" | "hearing" | "order" | "next_hearing" | "victory" | "update" | "disposed";
  event_date: string;
  source_url?: string | null;
}

const TYPE_META: Record<NewsItem["event_type"], { label: string; color: string; bg: string }> = {
  filing:      { label: "Filed",        color: "#6E6E73", bg: "#F5F5F7" },
  hearing:     { label: "Hearing",      color: "#0062c4", bg: "#E5F1FF" },
  order:       { label: "Court order",  color: "#6a25e6", bg: "#F1E9FF" },
  next_hearing:{ label: "Next hearing", color: "#8f5200", bg: "#FFEDC2" },
  victory:     { label: "Victory",      color: "#1b6e30", bg: "#DFF5E4" },
  update:      { label: "Update",       color: "#6E6E73", bg: "#F5F5F7" },
  // Neutral on purpose: "closed" is not "won" — only the written order says what the court directed.
  disposed:    { label: "Case closed",  color: "#3A3A3C", bg: "#E5E5EA" },
};

function formatDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export default function CaseNewsPage() {
  const router = useRouter();
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    const t = localStorage.getItem("sp_token");
    if (!t) { router.replace("/register"); return; }
    fetch("/api/case-news", { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" })
      .then(r => {
        // Session problem (expired/invalid login) — back to entry.
        if (r.status === 403) { router.replace("/register"); return null; }
        return r.json();
      })
      .then(j => {
        if (!j) return; // redirected above
        // API hiccup — show an error, never dump a logged-in user to registration.
        if (!j.success) { setLoadError(true); setLoading(false); return; }
        setItems(j.data ?? []);
        setLoading(false);
      })
      .catch(() => { setLoadError(true); setLoading(false); });
  }, [router]);

  const batches = useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of items) if (!seen.has(n.batch_slug)) seen.set(n.batch_slug, n.batch_name);
    return [...seen.entries()].map(([slug, name]) => ({ slug, name }));
  }, [items]);

  const visible = filter === "all" ? items : items.filter(n => n.batch_slug === filter);

  return (
    <main className="min-h-screen pb-10" style={{ background: "#F5F5F7" }}>
      <PageHeader
        title="Case News"
        subtitle="What happened, when — every batch, both colleges"
        backHref="/dashboard"
        gradient="#0066cc"
      />

      <div className="px-4 pt-5" style={{ maxWidth: 640, margin: "0 auto" }}>
        {!loading && batches.length > 1 && (
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 12, marginBottom: 4 }}>
            {[{ slug: "all", name: "All batches" }, ...batches].map(b => (
              <button
                key={b.slug}
                onClick={() => setFilter(b.slug)}
                style={{
                  flexShrink: 0, border: "none", cursor: "pointer",
                  padding: "8px 14px", borderRadius: 20,
                  fontSize: 12.5, fontWeight: 700,
                  background: filter === b.slug ? "#0066cc" : "#fff",
                  color: filter === b.slug ? "#fff" : "#1D1D1F",
                  boxShadow: "0 1px 4px rgba(0,0,0,.06)",
                }}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          [1, 2, 3].map(i => (
            <div key={i} className="bg-white rounded-2xl p-4 shadow-sm animate-pulse" style={{ marginBottom: 12 }}>
              <div className="h-3 bg-gray-100 rounded w-1/4 mb-3" />
              <div className="h-3 bg-gray-100 rounded w-full mb-2" />
              <div className="h-3 bg-gray-100 rounded w-2/3" />
            </div>
          ))
        ) : loadError ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
            <div className="text-3xl mb-2">📡</div>
            <p className="text-sm font-bold text-gray-700">Couldn't load news</p>
            <p className="text-xs text-gray-500 mt-1">
              Check your connection and try again.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: 12, border: "none", cursor: "pointer",
                padding: "10px 22px", borderRadius: 20,
                fontSize: 13, fontWeight: 700,
                background: "#0066cc", color: "#fff",
              }}
            >
              Try again
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
            <div className="text-3xl mb-2">📰</div>
            <p className="text-sm font-bold text-gray-700">No news yet</p>
            <p className="text-xs text-gray-500 mt-1">
              Case updates for each batch will appear here as they happen.
            </p>
          </div>
        ) : (
          <div style={{ position: "relative", paddingLeft: 22 }}>
            <div style={{ position: "absolute", left: 7, top: 8, bottom: 8, width: 2, background: "#E5E5EA", borderRadius: 2 }} />
            {visible.map(n => {
              const meta = TYPE_META[n.event_type] ?? TYPE_META.update;
              return (
                <div key={n.id} style={{ position: "relative", marginBottom: 12 }}>
                  <div style={{
                    position: "absolute", left: -21, top: 18, width: 12, height: 12,
                    borderRadius: 6, background: meta.color, border: "2.5px solid #F5F5F7",
                  }} />
                  <a href={`/news/${n.id}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                    <div className="bg-white rounded-2xl p-4 shadow-sm active:scale-[0.99] transition-transform">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: "#6e6e73" }}>{formatDate(n.event_date)}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 800, padding: "3px 9px", borderRadius: 20,
                        color: meta.color, background: meta.bg,
                      }}>
                        {meta.label}
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#6e6e73" }}>{n.batch_name}</span>
                    </div>
                    <p style={{ fontSize: 14.5, fontWeight: 800, color: "#1D1D1F", margin: 0, lineHeight: 1.35 }}>{n.title}</p>
                    {n.body && (
                      <p style={{ fontSize: 13, color: "#3A3A3C", margin: "6px 0 0", lineHeight: 1.55 }}>{n.body}</p>
                    )}
                    {n.source_url && (
                      <span style={{ display: "inline-block", marginTop: 8, fontSize: 12, fontWeight: 700, color: "#6e6e73" }}>
                        (source attached)
                      </span>
                    )}
                    <span style={{ display: "block", marginTop: 6, fontSize: 12, fontWeight: 700, color: "#0066cc" }}>
                      View details →
                    </span>
                  </div>
                  </a>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
