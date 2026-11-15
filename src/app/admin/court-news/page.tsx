"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, ExternalLink, RefreshCw, Scale } from "lucide-react";
import { ui } from "@/lib/student-ui";
import { formatCourtDate } from "@/lib/case-clarity";
import type { CourtNewsBatch } from "@/lib/services/court-news";
import type { CourtEvent, CourtEventType } from "@/lib/court-timeline";

/**
 * Court News — for each batch, what happened in its court case, in plain
 * words, newest first. It is read straight from the High Court's website
 * (about hourly) — nobody types anything here. This replaced the old "Case
 * News" screen, a blank form that never held a single row.
 */

const SHOWN_AT_FIRST = 6;

const TYPE_META: Record<CourtEventType, { label: string; color: string; bg: string }> = {
  filing: { label: "Filed", color: ui.textSecondary, bg: ui.canvas },
  order: { label: "Court order", color: ui.accent, bg: ui.accentSoft },
  hearing: { label: "Hearing today", color: ui.warning, bg: ui.warningSoft },
  next_hearing: { label: "Next hearing", color: ui.warning, bg: ui.warningSoft },
  update: { label: "Update", color: ui.textSecondary, bg: ui.canvas },
  // Neutral on purpose: "closed" is not "won" — only the written order says what the court directed.
  disposed: { label: "Case closed", color: ui.textPrimary, bg: "#e5e5ea" },
};

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

function EventRow({ e }: { e: CourtEvent }) {
  const meta = TYPE_META[e.type] ?? TYPE_META.update;
  return (
    <li style={{ position: "relative", paddingBottom: 14, listStyle: "none" }}>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: -21,
          top: 4,
          width: 11,
          height: 11,
          borderRadius: 6,
          background: e.minor ? ui.borderStrong : meta.color,
          border: `2px solid ${ui.surface}`,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: ui.textSecondary }}>{formatCourtDate(e.date)}</span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: ui.radius.pill,
            color: meta.color,
            background: meta.bg,
          }}
        >
          {meta.label}
        </span>
      </div>
      <p
        style={{
          fontSize: e.minor ? 13 : 14,
          fontWeight: e.minor ? 600 : 700,
          color: e.minor ? ui.textSecondary : ui.textPrimary,
          margin: "4px 0 0",
          lineHeight: 1.35,
        }}
      >
        {e.title}
      </p>
      {e.body && (
        <p style={{ fontSize: 12.5, color: ui.textSecondary, margin: "3px 0 0", lineHeight: 1.5 }}>{e.body}</p>
      )}
      {e.url && (
        <a
          href={e.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            marginTop: 6,
            fontSize: 12.5,
            fontWeight: 700,
            color: ui.accent,
            textDecoration: "underline",
          }}
        >
          Open order (PDF) <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

function BatchCard({ b, onAddCase }: { b: CourtNewsBatch; onAddCase: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const events = showAll ? b.events : b.events.slice(0, SHOWN_AT_FIRST);
  const closed = b.court?.tone === "closed";

  return (
    <section
      aria-label={`${b.name} court news`}
      style={{
        background: ui.surface,
        borderRadius: ui.radius.card,
        border: `1px solid ${ui.border}`,
        boxShadow: ui.shadow.card,
        padding: "16px 16px 6px",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: ui.textPrimary, margin: 0 }}>{b.name}</h2>
          <p style={{ fontSize: 12, color: ui.textSecondary, margin: "3px 0 0" }}>
            {b.college}
            {b.caseLabel ? ` · ${b.caseLabel}` : ""}
          </p>
        </div>
        {b.court && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 11,
              fontWeight: 700,
              padding: "3px 10px",
              borderRadius: ui.radius.pill,
              color: closed ? ui.textPrimary : ui.warning,
              background: closed ? "#e5e5ea" : ui.warningSoft,
            }}
          >
            {closed ? "Case closed" : "Case pending"}
          </span>
        )}
      </div>

      {!b.caseLabel ? (
        <div style={{ padding: "12px 0 12px" }}>
          <p style={{ fontSize: 13, color: ui.textSecondary, margin: 0, lineHeight: 1.5 }}>
            No court case added yet. When the lawyer sends the case number, add it here and the court&apos;s updates
            will show up on this page by themselves.
          </p>
          <button
            onClick={onAddCase}
            style={{
              marginTop: 10,
              padding: "9px 14px",
              borderRadius: ui.radius.button,
              border: `1px solid ${ui.border}`,
              background: ui.canvas,
              color: ui.accent,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Add case number
          </button>
        </div>
      ) : !b.court ? (
        <p style={{ fontSize: 13, color: ui.textSecondary, margin: "12px 0", lineHeight: 1.5 }}>
          The court&apos;s website didn&apos;t answer just now. Try again in a few minutes.
        </p>
      ) : (
        <>
          <div style={{ marginTop: 12, padding: "10px 12px", background: ui.canvas, borderRadius: ui.radius.button }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: ui.textPrimary, margin: 0 }}>{b.court.headline}</p>
            {b.court.detail && (
              <p style={{ fontSize: 12.5, color: ui.textSecondary, margin: "3px 0 0", lineHeight: 1.45 }}>
                {b.court.detail}
              </p>
            )}
            {b.court.checkedAt && (
              <p style={{ fontSize: 11.5, color: ui.textTertiary, margin: "6px 0 0" }}>
                Checked with the court {timeAgo(b.court.checkedAt)}
                {b.court.stale ? " — the court's site didn't answer, this is the last copy we had" : ""}
              </p>
            )}
          </div>

          {b.events.length === 0 ? (
            <p style={{ fontSize: 13, color: ui.textSecondary, margin: "12px 0", lineHeight: 1.5 }}>
              Nothing has been recorded by the court yet.
            </p>
          ) : (
            <>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: ui.textTertiary, textTransform: "uppercase", letterSpacing: 0.8, margin: "16px 0 10px" }}>
                What happened
              </h3>
              <div style={{ position: "relative", paddingLeft: 22 }}>
                <div
                  aria-hidden="true"
                  style={{ position: "absolute", left: 5, top: 8, bottom: 14, width: 2, background: ui.border, borderRadius: 2 }}
                />
                <ol style={{ margin: 0, padding: 0 }}>
                  {events.map((e) => (
                    <EventRow key={e.id} e={e} />
                  ))}
                </ol>
              </div>
              {b.events.length > SHOWN_AT_FIRST && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  aria-expanded={showAll}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    width: "100%",
                    padding: "10px",
                    margin: "0 0 10px",
                    border: "none",
                    background: "none",
                    color: ui.accent,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {showAll ? "Show fewer" : `Show all ${b.events.length} events`}
                  <ChevronDown
                    size={15}
                    strokeWidth={2.2}
                    aria-hidden="true"
                    style={{ transform: showAll ? "rotate(180deg)" : "none" }}
                  />
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export default function AdminCourtNews() {
  const router = useRouter();
  const [batches, setBatches] = useState<CourtNewsBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/court-news", {
        headers: { Authorization: `Bearer ${localStorage.getItem("sp_token") ?? ""}` },
        cache: "no-store",
      });
      const j = await res.json();
      if (!j?.success) throw new Error("bad response");
      setBatches(j.data.batches as CourtNewsBatch[]);
    } catch {
      setError("Couldn't load the court news. Check your connection and try again.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: ui.canvas,
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        padding: "20px 16px 110px",
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <button
          onClick={() => router.push("/admin")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            color: ui.accent,
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
            padding: "6px 0",
          }}
        >
          <ArrowLeft size={16} strokeWidth={2.2} aria-hidden="true" /> Admin
        </button>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, margin: "8px 0 4px" }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.6, color: ui.textPrimary, margin: 0 }}>Court News</h1>
          <button
            onClick={load}
            disabled={refreshing}
            aria-label="Refresh court news"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 12px",
              borderRadius: ui.radius.pill,
              border: `1px solid ${ui.border}`,
              background: ui.surface,
              color: ui.accent,
              fontSize: 13,
              fontWeight: 700,
              cursor: refreshing ? "default" : "pointer",
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <RefreshCw size={14} strokeWidth={2.2} aria-hidden="true" /> {refreshing ? "Checking…" : "Refresh"}
          </button>
        </div>
        <p style={{ fontSize: 14, color: ui.textSecondary, margin: "0 0 4px", lineHeight: 1.5 }}>
          What happened in each batch&apos;s court case, newest first.
        </p>
        <p style={{ fontSize: 12.5, color: ui.textTertiary, margin: "0 0 16px", lineHeight: 1.5 }}>
          This is read from the High Court&apos;s own website by itself (about every hour) — you don&apos;t type anything
          here. To tell students something yourself, use{" "}
          <button
            onClick={() => router.push("/admin/announcements")}
            style={{ background: "none", border: "none", padding: 0, color: ui.accent, fontWeight: 700, fontSize: "inherit", cursor: "pointer", textDecoration: "underline" }}
          >
            Announce
          </button>
          .
        </p>

        {error && (
          <div role="alert" style={{ background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, color: ui.danger, borderRadius: ui.radius.button, padding: "12px 14px", fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {batches === null && !error ? (
            <>
              <div style={{ height: 170, borderRadius: ui.radius.card, background: "rgba(0,0,0,.06)" }} />
              <div style={{ height: 170, borderRadius: ui.radius.card, background: "rgba(0,0,0,.06)" }} />
            </>
          ) : batches && batches.length === 0 ? (
            <div style={{ textAlign: "center", padding: "36px 12px", color: ui.textSecondary, fontSize: 14 }}>
              <Scale size={28} strokeWidth={1.6} aria-hidden="true" style={{ margin: "0 auto 8px", display: "block" }} />
              No batch has a court case yet.
            </div>
          ) : (
            (batches ?? []).map((b) => <BatchCard key={b.id} b={b} onAddCase={() => router.push("/admin/batches")} />)
          )}
        </div>
      </div>
    </main>
  );
}
