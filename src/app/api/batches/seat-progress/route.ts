import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { PETITION_MIN_SEATS } from "@/lib/config";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * GET /api/batches/seat-progress
 *
 * For the authenticated student, reports how many students have PAID in
 * their batch and how many are still needed to reach the minimum required to
 * start the petition (PETITION_MIN_SEATS). Read-only. Used by the dashboard to
 * show a live "X of 40 seats · petition starts at 40" note.
 *
 * Only paid students count. A registered-but-unpaid student is NOT added
 * to the count — the petition starts when enough students have paid.
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return forbidden();

  try {
    const db = createServiceClient();

    const { data: profile } = await db
      .from("profiles")
      .select("batch_id, batches!profiles_batch_id_fkey(name, college, status)")
      .eq("id", user.profileId)
      .maybeSingle();

    if (!profile?.batch_id) {
      return ok({ has_batch: false, min_seats: PETITION_MIN_SEATS });
    }

    // "Seats" = students who have PAID in this batch (payment approved).
    // A registered-but-unpaid student is NOT added to the count — the
    // petition starts only when enough students have paid. A student can
    // hold several approved payment rows (the UPI split is two payments of
    // half the fee), so count distinct students, never rows.
    const { data: approvedRows } = await db
      .from("payments")
      .select("student_id")
      .eq("batch_id", profile.batch_id)
      .eq("status", "approved");

    const paid = new Set((approvedRows ?? []).map((r: { student_id: string }) => r.student_id)).size;
    // PostgREST types an embedded to-one as an array; at runtime it's an object.
    const b = profile.batches as any;
    const batch = (Array.isArray(b) ? b[0] : b) as
      { name: string | null; college: string | null; status: string | null } | null;

    // "X of 50 seats — the petition starts at 50" is a message about a batch
    // that is still filling. Students whose batch has already ENDED were being
    // shown it too, counting their own finished batch (GNIT Batch 1 sat at
    // 24/50), which reads as "your petition never started" to people whose
    // petition is long since done. The card is for open batches only.
    const status = String(batch?.status ?? "");
    const accepting = ["active", "pending_setup", "full"].includes(status);

    return ok({
      has_batch: true,
      accepting,
      batch_status: status || null,
      batch_name: batch?.name ?? null,
      college: batch?.college ?? null,
      // registered_count is kept as an alias (same paid-only value) so an
      // older cached app shell still reads the count instead of 0.
      registered_count: paid,
      paid_count: paid,
      min_seats: PETITION_MIN_SEATS,
      reached: paid >= PETITION_MIN_SEATS,
      remaining: Math.max(0, PETITION_MIN_SEATS - paid),
    });
  } catch (e) {
    console.error("[api/batches/seat-progress]", e);
    return serverError();
  }
}
