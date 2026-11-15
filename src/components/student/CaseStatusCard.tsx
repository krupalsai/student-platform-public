"use client";
import { useEffect, useState } from "react";
import { Scale, ExternalLink, Clock, Check, FileText, Radio } from "lucide-react";
import { ui } from "@/lib/student-ui";
import { DisposedBanner, FreshnessLine, KnownUnknownPanel } from "@/components/case/CaseClarityBits";
import {
  disposalMeaning,
  disposedBannerTitle,
  freshnessLine,
  knownUnknown,
  statusMeaning,
  writtenOrderStep,
} from "@/lib/case-clarity";

/** "https://x.com" stays as-is; "csis.tshc.gov.in" gets a scheme prepended
 *  so window.open() doesn't treat it as a relative in-app path. */
function normalizeCourtUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

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
  /** Best-effort only — see src/lib/services/court-case.ts's doc comment.
   *  Optional so a stale cached row from before this field existed just
   *  shows no live-watch prompt, not an error. */
  judgmentLikelyToday?: boolean;
  judgmentHintText?: string | null;
  liveCourtsUrl?: string;
  listedToday?: boolean;
  /** Fresh (never cached) — which hall streams this case's judge and
   *  whether it's live right now. Null when the board didn't answer or no
   *  hall matched; the card then falls back to the generic board link. */
  liveHall?: { hallName: string; courtCode: string; streaming: boolean; watchUrl: string } | null;
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** "30/09/2026" -> true if that's today in IST. Client-side twin of the
 *  server's isDateTodayIST, so the live banner also works on a cached
 *  status row saved before the server started sending `listedToday`. */
function isListingTodayIST(ddmmyyyy: string | null | undefined): boolean {
  if (!ddmmyyyy) return false;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy.trim());
  if (!m) return false;
  const todayIST = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return todayIST === `${m[3]}-${m[2]}-${m[1]}`;
}

interface TrackerStep {
  key: string;
  label: string;
  date: string | null;
  state: "done" | "active" | "pending";
  /** Plain-English gloss shown under the step, for students with no legal background. */
  note?: string | null;
  /** When set, a "View order" link renders on this step. */
  orderUrl?: string | null;
  /** When true, the note is shown even for pending steps (default: hidden). */
  showNoteWhenPending?: boolean;
}

/**
 * Turns the court's raw case fields into an Amazon-delivery-style ordered
 * stage list ("Ordered → Shipped → Out for delivery → Delivered") instead
 * of a plain number-and-link. Filed/Registered are "done" once the court
 * has ever returned that date; an interim order (if any) is its own
 * completed stage; the final stage is either "Disposed" (done, green) or
 * "Next Hearing" (active, blue) depending on the case's real live status —
 * never both, since a disposed case has no next hearing. Each step carries
 * a short plain-English `note` so a student never has to guess what a term
 * like "Registered" or "Order" actually means.
 *
 * Clarity upgrade: the caller appends the written-order-copy step (via
 * `writtenOrderStep` from @/lib/case-clarity) after this — greyed
 * "Awaiting publication" while the order PDF is unpublished.
 */
function buildTrackerSteps(cs: CourtCaseStatus): TrackerStep[] {
  const steps: TrackerStep[] = [
    {
      key: "filed", label: "Petition Filed", date: cs.filingDate,
      state: cs.filingDate ? "done" : "pending",
      note: "Your petition was submitted to the court.",
    },
    {
      key: "registered", label: "Registered", date: cs.registrationDate,
      state: cs.registrationDate ? "done" : "pending",
      note: "The court accepted the case for hearing and gave it a case number.",
    },
  ];
  if (cs.latestOrder?.date) {
    steps.push({
      key: "order",
      label: cs.latestOrder.type ? `Order — ${cs.latestOrder.type}` : "Latest Order",
      date: cs.latestOrder.date,
      state: "done",
      note: "An instruction the court issued while the case was ongoing — not the final decision.",
    });
  }
  if (cs.status === "DISPOSED") {
    steps.push({
      key: "disposed",
      label: cs.disposalType ? `Disposed — ${cs.disposalType}` : "Disposed",
      date: cs.disposalDate,
      state: "done",
      note: disposalMeaning(cs.disposalType) ?? "The court has given its final decision on this case.",
    });
  } else if (cs.listingDate) {
    steps.push({
      key: "hearing", label: "Next Hearing", date: cs.listingDate, state: "active",
      note: "The date the court will next take up this case.",
    });
  } else {
    steps.push({
      key: "waiting", label: "Awaiting next update", date: null, state: "active",
      note: "No hearing date yet — check back after the court schedules one.",
    });
  }
  return steps;
}

function CaseTracker({ steps }: { steps: TrackerStep[] }) {
  return (
    <div style={{ marginTop: 4 }}>
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const dotBg = step.state === "done" ? ui.success : step.state === "active" ? ui.accent : ui.canvas;
        return (
          <div key={step.key} style={{ display: "flex", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div
                style={{
                  width: 22, height: 22, borderRadius: "50%", background: dotBg,
                  border: step.state === "pending" ? `2px solid ${ui.borderStrong}` : "none",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  boxShadow: step.state === "active" ? "0 0 0 4px rgba(0,102,204,0.16)" : undefined,
                  animation: step.state === "active" ? "case-tracker-pulse 1.8s ease-in-out infinite" : undefined,
                }}
              >
                {step.state === "done" && <Check size={13} strokeWidth={3} color="#fff" />}
                {step.state === "active" && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#fff" }} />}
              </div>
              {!isLast && (
                <div style={{ width: 2, flex: 1, minHeight: 22, marginTop: 2, background: step.state === "done" ? ui.success : ui.border }} />
              )}
            </div>
            <div style={{ paddingBottom: isLast ? 2 : 16 }}>
              <p style={{ fontSize: 13.5, fontWeight: 600, color: step.state === "pending" ? ui.textTertiary : ui.textPrimary, margin: 0 }}>
                {step.label}
              </p>
              {step.date ? (
                <p style={{ fontSize: 12, color: ui.textSecondary, margin: "2px 0 0" }}>{step.date}</p>
              ) : step.state === "pending" ? (
                <p style={{ fontSize: 12, color: ui.textTertiary, margin: "2px 0 0" }}>Pending</p>
              ) : null}
              {step.note && (step.state !== "pending" || step.showNoteWhenPending) && (
                <p style={{ fontSize: 11.5, color: ui.textTertiary, margin: "3px 0 0", lineHeight: 1.4, maxWidth: 260 }}>{step.note}</p>
              )}
              {step.orderUrl && (
                <button
                  onClick={() => window.open(step.orderUrl!, "_blank", "noopener,noreferrer")}
                  style={{
                    marginTop: 6, display: "inline-flex", alignItems: "center", gap: 4,
                    background: "none", border: "none", padding: 0, cursor: "pointer",
                    fontSize: 12, fontWeight: 600, color: ui.accent,
                  }}
                >
                  View order <ExternalLink size={11} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        );
      })}
      <style>{`@keyframes case-tracker-pulse { 0%,100% { box-shadow: 0 0 0 4px rgba(0,102,204,0.16); } 50% { box-shadow: 0 0 0 7px rgba(0,102,204,0.08); } }`}</style>
    </div>
  );
}

/**
 * The auto-fetched court-case tracker (items #152-154), extracted so it can
 * appear on both the Batch tab and Home (item #158 follow-up: "add this
 * home") without duplicating the fetch/tracker logic in two files.
 * Renders nothing when the batch has no case number on file yet.
 *
 * Clarity upgrade: disposed cases get a plain-words banner (instead of a
 * bare "DISPOSED" meaning line), a "No new update since …" freshness line,
 * a written-order-copy timeline step, and a what-we-know / what-we-don't
 * panel — so nobody has to guess what happened or whether anything is new.
 */
export default function CaseStatusCard({ batch, authHeader }: { batch: any; authHeader: () => Record<string, string> }) {
  const [caseStatus, setCaseStatus] = useState<CourtCaseStatus | null>(null);
  const [caseCheckedAt, setCaseCheckedAt] = useState<string | null>(null);
  const [caseStale, setCaseStale] = useState(false);
  const [caseChecking, setCaseChecking] = useState(false);
  /** Bumped every 5 minutes on a listing day so the card re-checks whether
   *  the judge's hall has started streaming. */
  const [pollTick, setPollTick] = useState(0);

  // Auto-check the court's own site for this batch's live case status,
  // instead of only handing the student a link to go look it up themselves.
  // See src/lib/services/court-case.ts for how — the court's search FORM
  // needs a captcha, but its own frontend has a plain, unauthenticated
  // lookup-by-known-case-number endpoint with none, which is what the
  // server route behind this fetch uses.
  useEffect(() => {
    if (!batch?.slug || !batch?.case_number) return;
    let cancelled = false;
    setCaseChecking(true);
    fetch(`/api/batches/${batch.slug}/case-status`, { headers: authHeader(), cache: "no-store" })
      .then(r => r.json())
      .then(j => {
        if (cancelled || !j?.success) return;
        setCaseStatus(j.data?.available ? j.data.status : null);
        setCaseCheckedAt(j.data?.checkedAt ?? null);
        setCaseStale(!!j.data?.stale);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCaseChecking(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.slug, batch?.case_number, pollTick]);

  // Prefer the server's signal; fall back to deriving it from the listing
  // date so rows cached before `listedToday` existed still show the banner.
  // Declared here (above the effects) because the polling effect depends
  // on it.
  const listedToday = caseStatus?.listedToday ?? isListingTodayIST(caseStatus?.listingDate);

  // On a listing day (pending case), re-check every 5 minutes so the banner
  // flips to "live now" the moment the judge's hall starts streaming —
  // the server only does the extra hall check on listing days, so this
  // costs ordinary views nothing.
  useEffect(() => {
    if (!listedToday || !caseStatus || caseStatus.status === "DISPOSED") return;
    const id = setInterval(() => setPollTick((t) => t + 1), 5 * 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedToday, caseStatus?.status]);

  if (!batch?.case_number) return null;

  // Clarity upgrade: append the written-order-copy step after "Disposed".
  const claritySteps = caseStatus
    ? (() => {
        const steps = buildTrackerSteps(caseStatus);
        const orderStep = writtenOrderStep(caseStatus);
        if (orderStep) steps.push(orderStep);
        return steps;
      })()
    : [];
  const ku = caseStatus ? knownUnknown(caseStatus) : { known: [], unknown: [] };
  const freshText = caseStatus ? freshnessLine(caseStatus) : null;
  const isDisposed = caseStatus?.status === "DISPOSED";

  return (
    <div style={{ background: ui.surface, borderRadius: ui.radius.card, border: `1px solid ${ui.border}`, boxShadow: ui.shadow.card, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: ui.radius.tile, background: ui.canvas, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Scale size={16} strokeWidth={1.8} color={ui.textPrimary} />
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: ui.textTertiary, textTransform: "uppercase", letterSpacing: 1, margin: 0 }}>Case Status</p>
          <p style={{ fontSize: 14, fontWeight: 600, color: ui.textPrimary, margin: "2px 0 0" }}>
            {[batch.case_type, batch.case_number].filter(Boolean).join(" ")}
            {batch.case_year ? ` / ${batch.case_year}` : ""}
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
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: ui.radius.pill, background: caseStatus.status === "DISPOSED" ? ui.successSoft : ui.warningSoft, color: caseStatus.status === "DISPOSED" ? ui.success : ui.warning }}>
                {caseStatus.status ?? "Status unknown"}
              </span>
              {caseCheckedAt && (
                <span style={{ fontSize: 10.5, color: ui.textTertiary, display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <Clock size={11} strokeWidth={1.8} /> auto-checked {timeAgo(caseCheckedAt)}{caseStale ? " (last known)" : ""}
                </span>
              )}
            </div>
            {freshText && (
              <FreshnessLine
                text={freshText}
                checkedText={caseCheckedAt ? `auto-checked ${timeAgo(caseCheckedAt)}${caseStale ? " (last known)" : ""}` : null}
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
                <p style={{ fontSize: 12, color: ui.textSecondary, margin: "5px 0 0", lineHeight: 1.4 }}>
                  {statusMeaning(caseStatus.status)}
                </p>
              )
            )}
          </div>
          <CaseTracker steps={claritySteps} />
          <KnownUnknownPanel known={ku.known} unknown={ku.unknown} />
          {caseStatus.judges && (
            <p style={{ fontSize: 12, color: ui.textSecondary, margin: "10px 0 0 34px" }}>
              <span style={{ color: ui.textTertiary }}>Judge:</span> <span style={{ color: ui.textPrimary, fontWeight: 600 }}>{caseStatus.judges}</span>
            </p>
          )}
          {caseStatus.judgmentLikelyToday && caseStatus.liveCourtsUrl && (
            <div style={{ marginTop: 14, background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, borderRadius: ui.radius.button, padding: "12px 14px" }}>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: ui.danger, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <Radio size={13} strokeWidth={2} /> Today's listing may be the judgment
              </p>
              <p style={{ fontSize: 11.5, color: ui.danger, margin: "5px 0 0", lineHeight: 1.5, opacity: 0.9 }}>
                Best-effort only, based on the court's own record: &ldquo;{caseStatus.judgmentHintText}&rdquo;.
                Not confirmed as final — the High Court live-streams every
                court hall, not individual cases{caseStatus.liveHall
                  ? <> — this opens <b>Hall {caseStatus.liveHall.hallName}</b>{caseStatus.judges ? <> ({caseStatus.judges})</> : null} directly</>
                  : caseStatus.judges
                    ? <> — search for <b>{caseStatus.judges}</b> on the board and open that hall</>
                    : ", so you'll need to find the right hall yourself once you open the board"}.
              </p>
              <button
                onClick={() => window.open(caseStatus.liveHall?.watchUrl ?? caseStatus.liveCourtsUrl!, "_blank", "noopener,noreferrer")}
                style={{ width: "100%", marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: ui.danger, border: "none", borderRadius: ui.radius.sm, padding: "10px", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
              >
                Watch Live Courts <ExternalLink size={13} strokeWidth={2} />
              </button>
            </div>
          )}
          {/* The judge's own hall is streaming RIGHT NOW — deep-link straight
              to it, so the button opens the case's hall, not the generic
              31-hall board. */}
          {caseStatus.liveCourtsUrl && listedToday && caseStatus.status !== "DISPOSED" && !caseStatus.judgmentLikelyToday && caseStatus.liveHall?.streaming && (
            <div style={{ marginTop: 14, background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, borderRadius: ui.radius.button, padding: "12px 14px" }}>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: ui.danger, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: ui.danger, display: "inline-block", flexShrink: 0, animation: "case-live-pulse 1.6s ease-in-out infinite" }} /> Hearing today — Hall {caseStatus.liveHall.hallName} is live now
              </p>
              <p style={{ fontSize: 11.5, color: ui.danger, margin: "5px 0 0", lineHeight: 1.5, opacity: 0.9 }}>
                This batch&apos;s case is listed today{caseStatus.judges ? <> before <b>{caseStatus.judges}</b></> : null}.
                This opens their court hall directly — not the general board.
              </p>
              <button
                onClick={() => window.open(caseStatus.liveHall!.watchUrl, "_blank", "noopener,noreferrer")}
                style={{ width: "100%", marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: ui.danger, border: "none", borderRadius: ui.radius.sm, padding: "10px", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
              >
                Watch Hall {caseStatus.liveHall.hallName} <ExternalLink size={13} strokeWidth={2} />
              </button>
              <style>{`@keyframes case-live-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
            </div>
          )}
          {/* Listed today and the hall is identified, but it isn't streaming
              yet — no fake "watch" button, just where to look and a promise
              the button appears when it goes live (the card re-checks every
              5 minutes while open). */}
          {caseStatus.liveCourtsUrl && listedToday && caseStatus.status !== "DISPOSED" && !caseStatus.judgmentLikelyToday && caseStatus.liveHall && !caseStatus.liveHall.streaming && (
            <div style={{ marginTop: 14, background: ui.canvas, border: `1px solid ${ui.border}`, borderRadius: ui.radius.button, padding: "12px 14px" }}>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>
                Listed today{caseStatus.judges ? <> before {caseStatus.judges}</> : null} · Hall {caseStatus.liveHall.hallName}
              </p>
              <p style={{ fontSize: 11.5, color: ui.textSecondary, margin: "5px 0 0", lineHeight: 1.5 }}>
                The hall isn&apos;t streaming right now. The watch button will appear here automatically when it goes live — no need to keep checking the board.
              </p>
            </div>
          )}
          {/* Hall couldn't be identified (judge name didn't match, or the
              board didn't answer) — the old honest generic-board banner as
              a fallback, never a dead end. */}
          {caseStatus.liveCourtsUrl && listedToday && caseStatus.status !== "DISPOSED" && !caseStatus.judgmentLikelyToday && !caseStatus.liveHall && (
            <div style={{ marginTop: 14, background: ui.dangerSoft, border: `1px solid ${ui.dangerSoftBorder}`, borderRadius: ui.radius.button, padding: "12px 14px" }}>
              <p style={{ fontSize: 12.5, fontWeight: 600, color: ui.danger, margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: ui.danger, display: "inline-block", flexShrink: 0 }} /> Hearing today — may be live now
              </p>
              <p style={{ fontSize: 11.5, color: ui.danger, margin: "5px 0 0", lineHeight: 1.5, opacity: 0.9 }}>
                This batch&apos;s case is listed today{caseStatus.judges ? <> before <b>{caseStatus.judges}</b></> : null}.
                The board streams by court hall, not by case — use the search box on the board to find your judge&apos;s hall and open it.
              </p>
              <button
                onClick={() => window.open(caseStatus.liveCourtsUrl!, "_blank", "noopener,noreferrer")}
                style={{ width: "100%", marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: ui.danger, border: "none", borderRadius: ui.radius.sm, padding: "10px", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
              >
                Watch Live Courts <ExternalLink size={13} strokeWidth={2} />
              </button>
            </div>
          )}
          {!!caseStatus.orders?.length && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${ui.divider}` }}>
              <p style={{ fontSize: 11, fontWeight: 600, color: ui.textTertiary, textTransform: "uppercase", letterSpacing: 1, margin: "0 0 8px" }}>
                Orders &amp; Judgments (as published by the court)
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {caseStatus.orders.map((o, i) => (
                  <div
                    key={i}
                    onClick={() => o.url && window.open(o.url, "_blank", "noopener,noreferrer")}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
                      background: ui.canvas, border: `1px solid ${ui.divider}`, borderRadius: ui.radius.button,
                      cursor: o.url ? "pointer" : "default",
                    }}
                  >
                    <div style={{ width: 30, height: 30, borderRadius: ui.radius.sm, background: ui.surface, border: `1px solid ${ui.border}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <FileText size={14} strokeWidth={1.8} color={ui.textSecondary} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p style={{ fontSize: 12.5, fontWeight: 600, color: ui.textPrimary, margin: 0 }}>{o.type ?? "Order"}</p>
                      <p style={{ fontSize: 11, color: ui.textTertiary, margin: "1px 0 0" }}>
                        {o.date ?? "Date not available"}{o.judge ? ` · ${o.judge}` : ""}
                      </p>
                    </div>
                    {o.url && (
                      <span style={{ fontSize: 11, fontWeight: 600, color: ui.accent, flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}>
                        View <ExternalLink size={11} strokeWidth={2} />
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 10.5, color: ui.textTertiary, margin: "8px 0 0", lineHeight: 1.4 }}>
                Only the date each order was passed is published by the court — no time is available.
              </p>
            </div>
          )}
        </div>
      ) : !caseChecking && (
        <p style={{ fontSize: 12, color: ui.textSecondary, margin: "10px 0 0", lineHeight: 1.5 }}>
          This batch&apos;s petition has been filed in court. We couldn&apos;t
          auto-check its live status just now — you can look it up
          yourself using the case number above.
        </p>
      )}

      {batch.case_status_url && (
        <button
          onClick={() => window.open(normalizeCourtUrl(batch.case_status_url), "_blank", "noopener,noreferrer")}
          style={{ width: "100%", marginTop: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: ui.canvas, border: `1px solid ${ui.border}`, borderRadius: ui.radius.button, padding: "11px", color: ui.textPrimary, fontWeight: 500, fontSize: 13.5, cursor: "pointer" }}
        >
          {caseStatus ? "View on Court Website" : "Check Status"} <ExternalLink size={14} strokeWidth={1.8} />
        </button>
      )}
    </div>
  );
}
