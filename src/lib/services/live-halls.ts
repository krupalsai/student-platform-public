/**
 * Maps a case's judge to the Telangana High Court's live-streaming hall and
 * reports whether THAT hall is actually streaming right now.
 *
 * The HC's live board (tshc.vconsol.com/live-courts) streams by COURT HALL,
 * not by case — so a "Watch Live Now" button that just opens the generic
 * 31-hall board never shows a case-related video. The board's own frontend
 * reads a plain, unauthenticated JSON endpoint
 * (`GET /api/v1/user/common/courts/all`) listing every hall with its judge
 * names and a live `streamingStatus` flag. This module uses it to match a
 * case's judge to their hall and build a deep link (`?courtId=`) that opens
 * that specific hall directly — the closest thing to a case-related video
 * the court's own system offers.
 *
 * Fail-soft everywhere: null on any failure means "no live-hall info,"
 * and callers must fall back to the generic board, never an error.
 */

const VCONSOL_COURTS_ALL_URL = "https://tshc.vconsol.com/api/v1/user/common/courts/all";
const FETCH_TIMEOUT_MS = 8_000;
/** Halls go live/offline around sittings — refresh often, but don't hit the
 *  board's endpoint on every single page view. */
const HALL_CACHE_TTL_MS = 3 * 60 * 1000;

export interface LiveHall {
  /** The hall's display name on the board, e.g. "22 J S J". */
  hallName: string;
  /** The board's id for this hall — used to deep-link straight to it. */
  courtCode: string;
  /** True when the hall is streaming RIGHT NOW. */
  streaming: boolean;
  /** Opens the live board with this hall already selected. */
  watchUrl: string;
}

/** Honorifics and titles the court and the board both decorate judge names
 *  with — stripped before comparing, so "Hon'ble Smt Justice Juvvadi
 *  Sridevi" matches "HON'BLE SMT. JUSTICE JUVVADI SRIDEVI". */
const NAME_NOISE_RE = /\b(hon|honble|ble|sri|smt|shri|justice|mr|mrs|ms|dr|the|chief)\b/gi;

function nameTokens(name: string): string[] {
  return name
    .replace(/[''.]/g, "")
    .replace(NAME_NOISE_RE, " ")
    .toLowerCase()
    .split(/[^a-z]+/)
    // Length > 2: bare initials ("N.V." -> "nv") never identify a judge on
    // their own and would block an otherwise clean surname match.
    .filter((t) => t.length > 2);
}

/** True when every token of the shorter name appears in the longer one —
 *  tolerant of "Juvvadi Sridevi" vs "JUVVADI SRIDEVI" and of one side
 *  carrying an initial the other omits. */
function tokensMatch(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const [shorter, longerSet] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  return shorter.every((t) => longerSet.has(t));
}

interface HallRow {
  courtCode: string;
  courtName: string;
  streamingStatus: boolean;
  judges: string[];
}

let hallsCache: { at: number; rows: HallRow[] } | null = null;

async function fetchHalls(): Promise<HallRow[] | null> {
  if (hallsCache && Date.now() - hallsCache.at < HALL_CACHE_TTL_MS) return hallsCache.rows;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(VCONSOL_COURTS_ALL_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    const rows: HallRow[] = data
      .filter((c: any) => c?.courtCode && c?.courtName)
      .map((c: any) => ({
        courtCode: String(c.courtCode),
        courtName: String(c.courtName),
        streamingStatus: c.streamingStatus === true,
        judges: Array.isArray(c.judgesDetails)
          ? c.judgesDetails.map((j: any) => String(j?.name ?? "")).filter(Boolean)
          : [],
      }));
    hallsCache = { at: Date.now(), rows };
    return rows;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The court's case-status text names the judge(s) hearing the case
 * (e.g. "Hon'ble Smt Justice Juvvadi Sridevi"); a division-bench string
 * may name two. Returns the hall whose judge list best matches any of the
 * case's judge names — the most name-tokens matched wins, so a full-name
 * match beats a surname-only coincidence — or null when nothing matches.
 * Null means "fall back to the generic board," not an error.
 */
export async function getLiveHallForJudges(caseJudges: string | null | undefined): Promise<LiveHall | null> {
  if (!caseJudges) return null;
  const rows = await fetchHalls();
  if (!rows) return null;
  const caseNames = String(caseJudges)
    .split(/[,;&/]|\band\b/i)
    .map((s) => nameTokens(s))
    .filter((t) => t.length > 0);

  let best: HallRow | null = null;
  let bestScore = 0;
  for (const row of rows) {
    let score = 0;
    for (const cn of caseNames) {
      for (const hj of row.judges) {
        const ht = nameTokens(hj);
        if (tokensMatch(cn, ht)) score = Math.max(score, Math.min(cn.length, ht.length));
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (!best) return null;
  return {
    hallName: best.courtName,
    courtCode: best.courtCode,
    streaming: best.streamingStatus,
    watchUrl: `https://tshc.vconsol.com/live-courts?courtId=${encodeURIComponent(best.courtCode)}`,
  };
}
