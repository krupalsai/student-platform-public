"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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
    day: "numeric", month: "long", year: "numeric",
  });
}

export default function NewsDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = (params?.id as string) ?? "";
  const [item, setItem] = useState<NewsItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const t = localStorage.getItem("sp_token");
    if (!t) { router.replace("/register"); return; }
    fetch("/api/case-news", { headers: { Authorization: `Bearer ${t}` }, cache: "no-store" })
      .then(r => {
        if (r.status === 403) { router.replace("/register"); return null; }
        return r.json();
      })
      .then(j => {
        if (!j) return;
        const found = (j.data ?? []).find((n: NewsItem) => n.id === id) ?? null;
        setItem(found);
        setFailed(!j.success || !found);
        setLoading(false);
      })
      .catch(() => { setFailed(true); setLoading(false); });
  }, [id, router]);

  const meta = item ? (TYPE_META[item.event_type] ?? TYPE_META.update) : null;

  return (
    <main className="min-h-screen pb-10" style={{ background: "#F5F5F7" }}>
      <PageHeader
        title="Case News"
        subtitle={item ? item.batch_name : "Details"}
        backHref="/news"
        gradient="#0066cc"
      />

      <div className="px-4 pt-5" style={{ maxWidth: 640, margin: "0 auto" }}>
        {loading ? (
          <div className="bg-white rounded-2xl p-5 shadow-sm animate-pulse">
            <div className="h-3 bg-gray-100 rounded w-1/3 mb-3" />
            <div className="h-4 bg-gray-100 rounded w-full mb-2" />
            <div className="h-3 bg-gray-100 rounded w-full mb-2" />
            <div className="h-3 bg-gray-100 rounded w-2/3" />
          </div>
        ) : failed || !item || !meta ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
            <p className="text-sm font-bold text-gray-700">Couldn't open this update</p>
            <p className="text-xs text-gray-500 mt-1">It may have been removed.</p>
            <button
              onClick={() => router.push("/news")}
              style={{
                marginTop: 12, border: "none", cursor: "pointer",
                padding: "10px 22px", borderRadius: 20,
                fontSize: 13, fontWeight: 700,
                background: "#0066cc", color: "#fff",
              }}
            >
              Back to Case News
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-2xl p-5 shadow-sm">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <span style={{
                fontSize: 11, fontWeight: 800, padding: "4px 12px", borderRadius: 20,
                color: meta.color, background: meta.bg,
              }}>
                {meta.label}
              </span>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#6e6e73" }}>
                {formatDate(item.event_date)}
              </span>
            </div>
            <p style={{ fontSize: 13, fontWeight: 700, color: "#6e6e73", margin: "0 0 6px" }}>
              {item.batch_name} · {item.college}
            </p>
            <h1 style={{ fontSize: 19, fontWeight: 800, color: "#1D1D1F", margin: "0 0 10px", lineHeight: 1.35 }}>
              {item.title}
            </h1>
            {item.body && (
              <p style={{ fontSize: 14.5, color: "#3A3A3C", margin: 0, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                {item.body}
              </p>
            )}
            {item.source_url && (
              <a
                href={item.source_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-block", marginTop: 16,
                  fontSize: 13, fontWeight: 700, color: "#0066cc",
                  textDecoration: "none",
                }}
              >
                View source document →
              </a>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
