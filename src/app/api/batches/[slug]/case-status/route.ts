import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { getBatchCaseStatus, isDateTodayIST } from "@/lib/services/court-case";
import { getLiveHallForJudges } from "@/lib/services/live-halls";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * Auto-fetched court case status for one batch (item #152 follow-up — "the
 * app must say everything by automatically checking the website" instead of
 * only linking a student out). See src/lib/services/court-case.ts for the
 * actual fetch and its caching/fail-soft rules; this route is a thin,
 * session-gated read of that.
 *
 * Also appends a fresh `liveHall` — which streaming hall belongs to this
 * case's judge and whether it's live RIGHT NOW (see
 * src/lib/services/live-halls.ts). This is checked on every call, never
 * read from or written to the hourly case-status cache row, because halls
 * go live/offline through the day — and only on listing days for pending
 * cases, so ordinary views cost nothing extra.
 *
 * Keyed by slug, not id — this sits inside the pre-existing
 * `/api/batches/[slug]` dynamic segment (Next.js requires every dynamic
 * folder at the same level to share one param name; `[id]` here would have
 * collided with that route's `[slug]`).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { error } = await requireSession(req);
  if (error) return forbidden();

  const { slug } = await params;
  try {
    const db = createServiceClient();
    const result = await getBatchCaseStatus(db, slug);
    const status = result.status;
    // A row cached before the server started sending `listedToday` still
    // carries its raw listing date — re-derive "listed today" from it with
    // the same IST logic the card uses client-side. The hall check must run
    // on every real listing day, whatever shape the cached row is in, or
    // newly added batches would show a dead fallback link on their day.
    const listedToday = status?.listedToday ?? isDateTodayIST(status?.listingDate);
    if (result.available && status && listedToday && status.status !== "DISPOSED") {
      status.liveHall = await getLiveHallForJudges(status.judges);
    }
    return ok(result);
  } catch (e) {
    console.error("[api/batches/[slug]/case-status]", e);
    return serverError();
  }
}
