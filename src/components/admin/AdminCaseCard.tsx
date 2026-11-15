"use client";

import { useEffect, useState } from "react";
import { Scale, ExternalLink, Clock, FileText } from "lucide-react";
import { ui } from "@/lib/student-ui";
import { DisposedBanner, FreshnessLine, KnownUnknownPanel } from "@/components/case/CaseClarityBits";
import {
  disposedBannerTitle,
  disposalMeaning,
  freshnessLine,
  knownUnknown,
  statusMeaning,
  writtenOrderStep,
} from "@/lib/case-clarity";

interface CourtOrder {
  date: string | null;
  type: string | null;
  judge: string | null;
  url: string | null;
}

interface CourtCaseStatus {
  status: string | null;
  listingDate: string | null;
  filingDate: string | null;
  registrationDate: string | null;
  disposalDate: string | null;
  disposalType: string | null;
  judges: string | null;
  purpose: string | null;
  latestOrder: { date: string | null; type: string | null } | null;
  orders?: CourtOrder[];
  petitionerCount: number | null;
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * AdminCaseCard — the case-clarity treatment for the admin side.
 * Same plain-words banner, freshness line and known/unknown panel as the
 * student card, plus a "Raw court record" expander with the unprocessed
 * fields (raw status/disposal strings, judge, check timestamps, cache
 * fresh/stale). No admin case-status view existed before — the admin batch
 * page only edited case numbers.
 *
 * Usage: <AdminCaseCard slug={batch.slug} caseLabel="WP 12345 / 2026" />
 */
export default function AdminCaseCard({
  slug,
  caseLabel,
  authHeader,
}: {
  slug: string;
  caseLabel: string;
  authHeader: () => Record<string, string>;
}) {
  const [caseStatus, setCaseStatus] = useState<CourtCaseStatus | null>(null);
  const [caseCheckedAt, setCaseCheckedAt] = useState<string | null>(null);
  const [caseStale, setCaseStale] = useState(false);
  const [caseChecking, setCaseChecking] = useState(false);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setCaseChecking(true);
    fetch(`/api/batches/${slug}/case-status`, { headers: authHeader(), cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j?.success) return;
        setCaseStatus(j.data?.available ? j.data.status : null);
        setCaseCheckedAt(j.data?.checkedAt ?? null);
        setCaseStale(!!j.data?.stale);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setCaseChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const isDisposed = caseStatus?.status === "DISPOSED";
  const ku = caseStatus ? knownUnknown(caseStatus) : { known: [], unknown: [] };
  const freshText = caseStatus ? freshnessLine(caseStatus) : null;
  const orderStep = caseStatus ? writtenOrderStep(caseStatus) : null;

  return (
    <div
      style={{
        background: ui.surface,
        borderRadius: ui.radius.card,
        border: `1px solid ${ui.border}`,
        boxShadow: ui.shadow.card,
        padding: "14px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: ui.radius.tile,
            background: ui.canvas,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Scale size={16} strokeWidth={1.8} color={ui.textPrimary} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: ui.textTertiary,
              textTransform: "uppercase",
              letterSpacing: 1,
              margin: 0,
            }}
          >
            Case Status · Admin
          </p>
          <p style={{ fontSize: 14, fontWeight: 600, color: ui.textPrimary, margin: "2px 0 0" }}>
            {caseLabel}
          </p>
        </div>
      </div>

      {caseChecking && !caseStatus && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 14, width: "70%", background: ui.canvas, borderRadius: 6, marginBottom: 6 }} />
          <div style={{ height: 14, width: "50%", background: ui.canvas, borderRadius: 6 }} />
        </div>
      )}

      {caseStatus ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "3px 9px",
                borderRadius: ui.radius.pill,
                background: isDisposed ? ui.successSoft : ui.warningSoft,
                color: isDisposed ? ui.success : ui.warning,
              }}
            >
              {caseStatus.status ?? "Status unknown"}
            </span>
            {caseCheckedAt && (
              <span
                style={{
                  fontSize: 10.5,
                  color: ui.textTertiary,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <Clock size={11} strokeWidth={1.8} /> auto-checked {timeAgo(caseCheckedAt)}
                {caseStale ? " (last known)" : ""}
              </span>
            )}
          </div>

          {freshText && (
            <FreshnessLine
              text={freshText}
              checkedText={
                caseCheckedAt
                  ? `auto-checked ${timeAgo(caseCheckedAt)}${caseStale ? " (last known)" : ""}`
                  : null
              }
            />
          )}

          {isDisposed ? (
            <div style={{ marginTop: 10 }}>
              <DisposedBanner
                title={disposedBannerTitle(caseStatus.disposalDate)}
                meaning={disposalMeaning(caseStatus.disposalType)}
              />
            </div>
          ) : (
            statusMeaning(caseStatus.status) && (
              <p style={{ fontSize: 12, color: ui.textSecondary, margin: "8px 0 0", lineHeight: 1.4 }}>
                {statusMeaning(caseStatus.status)}
              </p>
            )
          )}

          {orderStep && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 13px",
                background: orderStep.state === "done" ? ui.successSoft : ui.canvas,
                border: `1px solid ${orderStep.state === "done" ? ui.successSoftBorder : ui.border}`,
                borderRadius: ui.radius.button,
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <FileText
                size={15}
                strokeWidth={1.8}
                color={orderStep.state === "done" ? ui.success : ui.textTertiary}
                style={{ flexShrink: 0 }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontSize: 12.5, fontWeight: 700, color: ui.textPrimary, margin: 0 }}>
                  Written order copy
                  {orderStep.state === "done" ? "" : " — awaiting publication"}
                </p>
                {orderStep.note && (
                  <p style={{ fontSize: 11.5, color: ui.textTertiary, margin: "3px 0 0", lineHeight: 1.45 }}>
                    {orderStep.note}
                  </p>
                )}
              </div>
              {orderStep.orderUrl && (
                <button
                  onClick={() => window.open(orderStep.orderUrl!, "_blank", "noopener,noreferrer")}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    color: ui.accent,
                    flexShrink: 0,
                  }}
                >
                  View <ExternalLink size={11} strokeWidth={2} />
                </button>
              )}
            </div>
          )}

          <KnownUnknownPanel known={ku.known} unknown={ku.unknown} />

          {/* Raw court record — the unprocessed fields, for admin eyes. */}
          <details style={{ marginTop: 12 }}>
            <summary
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: ui.accent,
                cursor: "pointer",
                listStyle: "none",
              }}
            >
              Raw court record
            </summary>
            <div
              style={{
                marginTop: 8,
                background: ui.canvas,
                border: `1px solid ${ui.divider}`,
                borderRadius: ui.radius.button,
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 5,
              }}
            >
              {[
                ["Raw status", caseStatus.status],
                ["Raw disposal type", caseStatus.disposalType],
                ["Judge", caseStatus.judges],
                ["Filing date", caseStatus.filingDate],
                ["Registration date", caseStatus.registrationDate],
                ["Disposal date", caseStatus.disposalDate],
                ["Last checked", caseCheckedAt],
                ["Cache", caseStale ? "stale (last known)" : "fresh"],
                ["IA numbers", "Not in the court's auto-fetched record"],
              ].map(([label, value]) => (
                <div key={label as string} style={{ display: "flex", gap: 8, fontSize: 11.5 }}>
                  <span style={{ color: ui.textTertiary, minWidth: 110, flexShrink: 0 }}>{label}</span>
                  <span style={{ color: ui.textPrimary, fontWeight: 500, wordBreak: "break-word" }}>
                    {value ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>
      ) : (
        !caseChecking && (
          <p style={{ fontSize: 12, color: ui.textSecondary, margin: "10px 0 0", lineHeight: 1.5 }}>
            Couldn&apos;t auto-check the live status just now.
          </p>
        )
      )}
    </div>
  );
}
