import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { loadCourtNews } from "@/lib/services/court-news";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * Admin "Court News": for each batch, what happened in its court case — read
 * from the High Court's website (cached up to an hour on the batch row).
 * Read-only; the only write anywhere in the chain is the cache refresh the
 * student Home card already triggers. Replaces the hand-typed /api/case-news
 * POST/DELETE editor.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();
    const batches = await loadCourtNews(db, { includeWithoutCase: true });
    return ok({ batches, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[api/admin/court-news]", err);
    return serverError();
  }
}
