import { SupabaseClient } from "@supabase/supabase-js";
import { getBatchCaseStatus, type CourtCaseStatus } from "@/lib/services/court-case";
import { getActiveColleges } from "@/lib/services/colleges";
import {
  buildCourtTimeline,
  courtHeadline,
  latestHappenedDate,
  toNewsItems,
  type CourtEvent,
  type CourtHeadline,
  type NewsItem,
} from "@/lib/court-timeline";

/**
 * Court News — what happened in each batch's court case, read from the High
 * Court's own website through the cached copy services/court-case.ts keeps on
 * the batch row (refreshed at most hourly, served stale if the court's site is
 * down). Replaces the old hand-typed "Case News" feed, which never held a row.
 *
 * Nothing here writes: the only side effect is getBatchCaseStatus refreshing a
 * stale cache, exactly as the student Home card already does.
 */

export interface CourtNewsBatch {
  id: string;
  slug: string;
  name: string;
  college: string;
  /** The batch's own status (active / closed / ...), not the court's. */
  batchStatus: string;
  /** "WP 12345 / 2026" — null when no case number has been added yet. */
  caseLabel: string | null;
  /** The court's answer, or null when there's no case or the court never answered. */
  court:
    | (CourtHeadline & {
        courtStatus: string | null;
        checkedAt: string | null;
        /** True when the court's site didn't answer and this is the last copy we had. */
        stale: boolean;
      })
    | null;
  /** Newest first. Empty when there's no case or the court never answered. */
  events: CourtEvent[];
  /** Date of the newest thing that actually happened (not a hearing still to come). */
  lastHappened: string | null;
}

interface BatchRow {
  id: string;
  slug: string;
  name: string;
  college: string;
  status: string;
  case_type: string | null;
  case_number: string | null;
  case_year: string | null;
}

export function caseLabelOf(b: Pick<BatchRow, "case_type" | "case_number" | "case_year">): string | null {
  if (!b.case_number) return null;
  return [b.case_type, b.case_number].filter(Boolean).join(" ") + (b.case_year ? ` / ${b.case_year}` : "");
}

/**
 * Every batch worth showing, with its court events. A batch with a case number
 * is always included; one without is included only when its college is active
 * (so the owner sees "no case added yet" for the running batches, but not for
 * the merchant-demo batch or a college nobody has joined).
 */
export async function loadCourtNews(
  db: SupabaseClient,
  opts: { includeWithoutCase?: boolean; nowMs?: number } = {}
): Promise<CourtNewsBatch[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const { data, error } = await db
    .from("batches")
    .select("id, slug, name, college, status, case_type, case_number, case_year")
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as BatchRow[];
  const activeColleges = opts.includeWithoutCase ? new Set((await getActiveColleges(db)).map((c) => c.id)) : new Set<string>();
  const shown = rows.filter((b) => b.case_number || (opts.includeWithoutCase && activeColleges.has(b.college)));

  const out = await Promise.all(
    shown.map(async (b): Promise<CourtNewsBatch> => {
      const caseLabel = caseLabelOf(b);
      const base = {
        id: b.id,
        slug: b.slug,
        name: b.name,
        college: b.college,
        batchStatus: String(b.status),
        caseLabel,
      };
      if (!caseLabel) return { ...base, court: null, events: [], lastHappened: null };

      let status: CourtCaseStatus | null = null;
      let checkedAt: string | null = null;
      let stale = false;
      try {
        const r = await getBatchCaseStatus(db, b.slug);
        if (r.available && r.status) {
          status = r.status;
          checkedAt = r.checkedAt;
          stale = r.stale;
        }
      } catch {
        // The court being unreachable must never break the page — show "didn't answer".
      }
      if (!status) return { ...base, court: null, events: [], lastHappened: null };

      const events = buildCourtTimeline(status, nowMs);
      return {
        ...base,
        court: { ...courtHeadline(status, nowMs), courtStatus: status.status, checkedAt, stale },
        events,
        lastHappened: latestHappenedDate(events, nowMs),
      };
    })
  );

  // Batches with the freshest news first; batches with no case last.
  return out.sort((a, b) => {
    const ka = a.caseLabel ? 1 : 0;
    const kb = b.caseLabel ? 1 : 0;
    if (ka !== kb) return kb - ka;
    return (b.lastHappened ?? "").localeCompare(a.lastHappened ?? "") || a.name.localeCompare(b.name);
  });
}

/**
 * The student "Case News" feed: the milestones of every batch's case, newest
 * first. Same visibility as before — a signed-in student sees every batch, both
 * colleges — and it carries only facts of the case, no names or numbers.
 */
export async function loadCourtNewsFeed(
  db: SupabaseClient,
  filter: { batch?: string | null; college?: string | null } = {},
  limit = 80
): Promise<NewsItem[]> {
  const batches = await loadCourtNews(db);
  const items: NewsItem[] = [];
  for (const b of batches) {
    if (filter.batch && b.slug !== filter.batch) continue;
    if (filter.college && b.college !== filter.college) continue;
    items.push(...toNewsItems({ slug: b.slug, name: b.name, college: b.college }, b.events));
  }
  return items.sort((a, b) => b.event_date.localeCompare(a.event_date)).slice(0, limit);
}
