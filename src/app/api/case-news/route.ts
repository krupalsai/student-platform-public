import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { loadCourtNewsFeed } from "@/lib/services/court-news";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * Student "Case News": what happened in each batch's court case, newest first.
 * Built from the High Court's own record (see src/lib/court-timeline.ts), not
 * from anything an admin types — the old manual feed (and its POST/DELETE) was
 * removed because it never held a single row. Everyone who is logged in sees
 * every batch's news, as before: it is the court's public record, and it carries
 * no names or case numbers.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireSession(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();
    const items = await loadCourtNewsFeed(db, {
      batch: req.nextUrl.searchParams.get("batch"),
      college: req.nextUrl.searchParams.get("college"),
    });
    return ok(items);
  } catch (err) {
    console.error("[api/case-news]", err);
    return serverError();
  }
}
