import { SupabaseClient } from "@supabase/supabase-js";
import { logSystemError } from "@/lib/system-errors";
import type { LiveHall } from "./live-halls";

/**
 * Auto-fetches a batch's writ-petition status directly from the Telangana
 * High Court's own public case-status portal (csis.tshc.gov.in), instead of
 * only linking a student out to check it themselves (item #152's original,
 * link-only design).
 *
 * The portal's SEARCH FORM requires a CAPTCHA — but its own frontend JS
 * (`assets/js/fetch.js`'s `getCaseDetailsWoCaptcha`, called by
 * `index.js`'s `getMainCaseDetails` for a follow-up lookup on an
 * already-known case number) hits a plain, unauthenticated GET endpoint
 * with NO captcha at all: `GET /getCaseDetails?mtype=&mno=&myear=`.
 * Confirmed against the court's public case-status endpoint — it returns
 * the public record for a known case number without the search-form captcha.
 * This is the court's documented lookup path for a known case, not a bypass
 * of the captcha used to rate-limit open-ended searches; nothing here submits or solves a
 * captcha.
 *
 * **Undocumented, unofficial use of a real endpoint — must fail soft
 * everywhere.** The court can change this at any time with no notice; every
 * caller of `fetchCourtCaseStatus` MUST treat a failure as "show the
 * cached/last-known status, or fall back to the manual link" and NEVER as
 * an error the student sees.
 */

const TSHC_BASE = "https://csis.tshc.gov.in";
/** Where the court's own frontend (assets/js/fetch.js) builds its order-PDF
 *  links from the relative `orderDetails` path the API returns — confirmed
 *  live against a real case's two real orders (200, application/pdf). */
const TSHC_ORDERS_BASE = "https://csis.tshc.gov.in/hcorders";
/** The Telangana HC's real, official live-streaming board — confirmed live
 *  on tshc.gov.in ("Live Streaming Board" nav link). It streams by COURT
 *  HALL, not by case. The board's own frontend reads a plain,
 *  unauthenticated JSON endpoint (`GET /api/v1/user/common/courts/all`)
 *  listing every hall with its judge names and a live `streamingStatus`
 *  flag — src/lib/services/live-halls.ts uses it to match a case's judge
 *  to their hall and deep-link straight to it (`?courtId=`), so the watch
 *  button opens the case's own hall instead of the generic 31-hall board.
 *  This constant remains the honest fallback when no hall could be
 *  matched. */
const TSHC_LIVE_COURTS_URL = "https://tshc.vconsol.com/live-courts";
const FETCH_TIMEOUT_MS = 10_000;
/** Don't hit the court's server on every page view — reuse a fetch this fresh. */
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Real words the court itself uses on a listing that's actually about a
 *  judgment/final order, as opposed to a routine procedural hearing — not
 *  invented, taken from how Indian HC case-status text is actually worded. */
const JUDGMENT_KEYWORD_RE = /judg[e]?ment|reserved|pronounce/i;

export interface CourtOrder {
  date: string | null;
  type: string | null;
  judge: string | null;
  /** Direct link to the order's own PDF on the court's site, or null if the
   *  API gave no file path for this order. Only a date is ever available —
   *  the court's own portal does not publish a time. */
  url: string | null;
}

/** A request made INSIDE the case (the court's "IA" list — e.g. a direction
 *  petition). Compact on purpose: the court's own free-text `prayer` and the
 *  advocate names are never stored, only what a plain timeline line needs. */
export interface CourtApplication {
  /** When it was filed, as the court gave it (ISO). */
  date: string | null;
  /** The court's paper type, e.g. "Direction Petition". */
  type: string | null;
  /** The court's status for it: "Pending" / "Disposed". */
  status: string | null;
  /** When the court decided it, if it has. */
  decidedOn: string | null;
}

/** A paper accepted into the case file (the court's "USR" list — vakalat,
 *  counter affidavit, memo of service…). Says nothing about WHO filed it. */
export interface CourtFiling {
  date: string | null;
  type: string | null;
  /** The registry's note: "Accepted", "ACCEPTED R4"… */
  status: string | null;
}

export interface CourtCaseStatus {
  status: string | null;
  listingDate: string | null;
  filingDate: string | null;
  registrationDate: string | null;
  disposalDate: string | null;
  disposalType: string | null;
  judges: string | null;
  purpose: string | null;
  latestOrder: { date: string | null; type: string | null } | null;
  /** Every order/judgment on file for this case, newest first, each linking
   *  to its own real PDF on the court's site — not just the latest one. */
  orders: CourtOrder[];
  /** Applications made inside the case, newest first. Cached rows written
   *  before these existed lack the key — `getBatchCaseStatus` refreshes
   *  those once. Used by the Court News timeline (src/lib/court-timeline.ts). */
  applications?: CourtApplication[];
  /** Papers accepted into the case file, newest first. */
  filings?: CourtFiling[];
  petitionerCount: number | null;
  /**
   * Best-effort signal for "today's listing might actually be the
   * judgment," not a confirmed fact — this court's API has NO field that
   * says "purpose of next hearing," so this is inferred from real court
   * text (the case status itself, or the most recent case-history
   * "business" entry) matching judgment-related keywords, combined with
   * today's date matching the listing date. It will read `false` for a
   * case with no such text yet (e.g. one still early in PENDING with no
   * case-history rows), which is the honest answer, not a false negative
   * to fix — there is nothing to detect yet.
   */
  judgmentLikelyToday: boolean;
  /** The real court text that triggered `judgmentLikelyToday`, shown to
   *  the student so the claim is verifiable against the court's own
   *  wording rather than asserted outright. Null when not likely. */
  judgmentHintText: string | null;
  liveCourtsUrl: string;
  /** True when the court's listing date is today (IST). Used to decide
   *  whether to surface the live-stream board prominently — the board
   *  streams by court hall, not by case, so this is "listed today, may be
   *  live now", never a claim that this specific case is on air. */
  listedToday: boolean;
  /** Which live-streaming hall belongs to this case's judge and whether
   *  it's streaming RIGHT NOW — checked fresh on every case-status call by
   *  the API route (halls go live/offline through the day), never stored
   *  in the hourly cache row. Null when the judge couldn't be matched to a
   *  hall or the board didn't answer; the card then falls back to the
   *  generic board link. */
  liveHall?: LiveHall | null;
  /** First petitioner on the court's record — the main petitioner
   *  (e.g. "Asha Rao" for WP 12345/2026). The route map
   *  highlights this person as the one who must be present when the batch
   *  goes to college: the lawyer's hard-copy parcel goes to the batch
   *  representative, but the petitioner has to be there in person. */
  mainPetitioner: string | null;
}

/** "23/09/2026" -> true if that's today, in IST (the court's own timezone) —
 *  comparing calendar dates, not a UTC/local-server mismatch. `nowMs`
 *  defaults to the real clock; injectable so this is directly unit-testable
 *  without mocking global time. */
export function isDateTodayIST(ddmmyyyy: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!ddmmyyyy) return false;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy);
  if (!m) return false;
  const istNow = new Date(nowMs + 5.5 * 60 * 60 * 1000);
  return (
    Number(m[1]) === istNow.getUTCDate() &&
    Number(m[2]) === istNow.getUTCMonth() + 1 &&
    Number(m[3]) === istNow.getUTCFullYear()
  );
}

/** First petitioner's name from the court's `petitioners` array — the main
 *  petitioner. Tolerant of the court's shapes: plain strings, or objects
 *  carrying the name under a few known keys. Trailing commas (the court's
 *  own "Name," display style) are stripped. */
function firstPetitionerName(petitioners: unknown): string | null {
  if (!Array.isArray(petitioners) || petitioners.length === 0) return null;
  const first = petitioners[0] as Record<string, unknown> | string | null | undefined;
  const clean = (s: string) => s.trim().replace(/,+\s*$/, "").trim() || null;
  if (typeof first === "string") return clean(first);
  if (first && typeof first === "object") {
    const raw = first["petName"] ?? first["name"] ?? first["petitionerName"] ?? first["partyName"] ?? first["petitioner"];
    if (typeof raw === "string") return clean(raw);
  }
  return null;
}

export interface JudgmentSignal {
  judgmentLikelyToday: boolean;
  judgmentHintText: string | null;
}

/**
 * The best-effort "is today's listing the judgment" check — pulled out as
 * its own pure function so it's directly unit-testable (see
 * scripts/test-court-judgment-signal.ts) without a network call. Only ever
 * true when BOTH the listing date is today AND a real piece of court text
 * (the case status, or the latest case-history "business" line) contains a
 * judgment-related word — a bare listing date on today, with no such text,
 * must never read as "judgment today" (that's just an ordinary hearing).
 */
export function computeJudgmentSignal(
  statusText: string | null | undefined,
  latestHistoryBusiness: string | null | undefined,
  listingDateDDMMYYYY: string | null | undefined,
  nowMs: number = Date.now()
): JudgmentSignal {
  if (!isDateTodayIST(listingDateDDMMYYYY, nowMs)) {
    return { judgmentLikelyToday: false, judgmentHintText: null };
  }
  if (statusText && JUDGMENT_KEYWORD_RE.test(statusText)) {
    return { judgmentLikelyToday: true, judgmentHintText: `Case status: ${statusText}` };
  }
  if (latestHistoryBusiness && JUDGMENT_KEYWORD_RE.test(latestHistoryBusiness)) {
    return { judgmentLikelyToday: true, judgmentHintText: latestHistoryBusiness };
  }
  return { judgmentLikelyToday: false, judgmentHintText: null };
}

const MAX_ROWS = 40;
const MAX_TEXT = 80;
const clip = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, MAX_TEXT) : null;
};
const rowsOf = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((r) => r && typeof r === "object") as Record<string, unknown>[]).slice(0, MAX_ROWS) : [];
const newestFirst = <T extends { date: string | null }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

/** The court's `ia` list -> compact applications. Tolerant: any field may be absent. */
export function parseApplications(raw: unknown): CourtApplication[] {
  return newestFirst(
    rowsOf(raw).map((r) => ({
      date: clip(r.filingDate),
      type: clip(r.miscPaperType),
      status: clip(r.status),
      decidedOn: clip(r.orderDate),
    }))
  );
}

/** The court's `usr` list -> compact filings. */
export function parseFilings(raw: unknown): CourtFiling[] {
  return newestFirst(
    rowsOf(raw).map((r) => ({ date: clip(r.usrDate), type: clip(r.usrType), status: clip(r.remarks) }))
  );
}

/** `file` looks like "2026/206300123452026_1.pdf" — encode each path
 *  segment on its own so the slash stays a real path separator. */
function buildOrderUrl(file: string | null | undefined): string | null {
  if (!file) return null;
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return `${TSHC_ORDERS_BASE}/${encoded}`;
}

/**
 * Raw fetch against the court's endpoint. Returns null on ANY failure
 * (network, timeout, non-200, unexpected shape, no matching case) rather
 * than throwing — every caller already treats null as "couldn't refresh
 * right now," which is the correct response to an unofficial, undocumented
 * dependency going away or changing shape without notice.
 */
export async function fetchCourtCaseStatus(
  caseType: string,
  caseNumber: string,
  caseYear: string
): Promise<CourtCaseStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ mtype: caseType, mno: caseNumber, myear: caseYear });
    const res = await fetch(`${TSHC_BASE}/getCaseDetails?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.primary) return null;

    const rawOrders = Array.isArray(data.orderdetails) ? data.orderdetails : [];
    // The court returns orders in filing order, not necessarily newest-first —
    // sort by date so "latest order" is actually the latest, not just the last
    // one in whatever order the API happened to return them.
    const sortedOrders = [...rawOrders].sort((a, b) =>
      new Date(b.dateOfOrders ?? 0).getTime() - new Date(a.dateOfOrders ?? 0).getTime()
    );
    const latest = sortedOrders[0];
    const orders: CourtOrder[] = sortedOrders.map((o) => ({
      date: o.dateOfOrders ?? null,
      type: o.orderType ?? null,
      judge: o.judge ?? null,
      url: buildOrderUrl(o.orderDetails),
    }));

    // Best-effort "is today's listing the judgment" check — see
    // computeJudgmentSignal's own doc comment.
    const rawHistory = Array.isArray(data.casehistory) ? data.casehistory : [];
    const latestHistoryBusiness: string | null = rawHistory.length
      ? (rawHistory[rawHistory.length - 1]?.business ?? null)
      : null;
    const { judgmentLikelyToday, judgmentHintText } = computeJudgmentSignal(
      data.primary.casestatus,
      latestHistoryBusiness,
      data.primary.listingdate
    );

    return {
      status: data.primary.casestatus ?? null,
      listingDate: data.primary.listingdate ?? null,
      filingDate: data.primary.filingdate ?? null,
      registrationDate: data.primary.registrationdate ?? null,
      disposalDate: data.primary.casestatus === "DISPOSED" ? (data.primary.disposaldate ?? null) : null,
      disposalType: data.primary.casestatus === "DISPOSED" ? (data.primary.disposaltype ?? null) : null,
      // The court's API is inconsistent across case types: most WP records
      // carry `judges`, some carry `coram` or a singular `judge`. Any of
      // them lets the live-hall matcher find the case's court hall, so
      // fall through all three before giving up — a new batch's case must
      // not silently lose its watch link over a field-name difference.
      judges: data.primary.judges ?? data.primary.coram ?? data.primary.judge ?? null,
      purpose: data.primary.purpose ?? null,
      latestOrder: latest ? { date: latest.dateOfOrders ?? null, type: latest.orderType ?? null } : null,
      orders,
      applications: parseApplications(data.ia),
      filings: parseFilings(data.usr),
      petitionerCount: Array.isArray(data.petitioners) ? data.petitioners.length : null,
      judgmentLikelyToday,
      judgmentHintText,
      liveCourtsUrl: TSHC_LIVE_COURTS_URL,
      listedToday: isDateTodayIST(data.primary.listingdate),
      mainPetitioner: firstPetitionerName(data.petitioners),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface BatchCaseStatusResult {
  available: boolean;
  status: CourtCaseStatus | null;
  checkedAt: string | null;
  stale: boolean;
}

/**
 * The read path a batch's /case-status route calls. Serves the cached
 * result straight from `batches.case_last_status_json` when it's still
 * fresh; refreshes from the court live only when the cache is missing or
 * older than CACHE_TTL_MS, and writes the refreshed result back onto the
 * SAME batch row (one row, no separate cache table needed — matches the
 * pattern item #152 already used for the case fields themselves).
 *
 * A live refresh that fails does NOT wipe out a still-present older cached
 * value — `stale: true` tells the caller it's showing an old-but-real
 * result rather than nothing, which is always better than an error screen
 * for something students are anxiously checking.
 */
export async function getBatchCaseStatus(
  db: SupabaseClient,
  batchSlug: string
): Promise<BatchCaseStatusResult> {
  const { data: batch } = await db
    .from("batches")
    .select("case_type, case_number, case_year, case_last_status_json, case_status_checked_at")
    .eq("slug", batchSlug)
    .maybeSingle();

  if (!batch?.case_number) return { available: false, status: null, checkedAt: null, stale: false };

  const cachedAt = batch.case_status_checked_at ? new Date(batch.case_status_checked_at).getTime() : 0;
  const isFresh = Date.now() - cachedAt < CACHE_TTL_MS;

  const cached = batch.case_last_status_json as CourtCaseStatus | null;
  // One-time migration: a cache row written before `mainPetitioner` (or the
  // applications/filings the Court News timeline reads) existed can't supply
  // them, so refresh live once instead of serving the old shape.
  const cacheHasPetitioner =
    !!cached && typeof cached === "object" && "mainPetitioner" in cached && "applications" in cached && "filings" in cached;

  if (isFresh && cached && cacheHasPetitioner) {
    return { available: true, status: cached, checkedAt: batch.case_status_checked_at, stale: false };
  }

  const fresh = await fetchCourtCaseStatus(batch.case_type ?? "", batch.case_number, batch.case_year ?? "");
  if (fresh) {
    const checkedAt = new Date().toISOString();
    await db.from("batches").update({ case_last_status_json: fresh, case_status_checked_at: checkedAt }).eq("slug", batchSlug);
    return { available: true, status: fresh, checkedAt, stale: false };
  }

  // Live refresh failed — serve whatever was cached before, if anything,
  // rather than an error. A court-site hiccup must never read as "your case
  // vanished."
  if (batch.case_last_status_json) {
    await logSystemError(db, "court-case/getBatchCaseStatus", new Error("live refresh failed, serving stale cache"), { batchSlug });
    return { available: true, status: batch.case_last_status_json as CourtCaseStatus, checkedAt: batch.case_status_checked_at, stale: true };
  }

  await logSystemError(db, "court-case/getBatchCaseStatus", new Error("live refresh failed, no cache to fall back to"), { batchSlug });
  return { available: false, status: null, checkedAt: null, stale: false };
}
