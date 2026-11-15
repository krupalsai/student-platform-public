import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, serverError, badRequest } from "@/lib/api-response";
import { PETITION_MIN_SEATS } from "@/lib/config";
import { bestPaymentPerStudent } from "@/lib/services/payments";
import { canAdminAccessBatch } from "@/lib/authz";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * GET /api/admin/batch-summary?batch_id=<uuid>
 *
 * Batch-level payment counter for the admin roster: how many students are
 * registered in a batch and where their payments stand — independent of any
 * roster filters. Each student is counted once by their BEST payment status
 * (approved always wins over a later stray row — see PAYMENT_STATUS_PRIORITY
 * in services/payments.ts; a plain "most recent row"
 * reducer here undercounted Paid by 1 for exactly this reason).
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  const batchId = req.nextUrl.searchParams.get("batch_id") ?? "";
  if (!batchId) return badRequest("batch_id is required");

  try {
    const db = createServiceClient();

    // Batch isolation: only a super_admin or an admin assigned to this
    // batch may read its payment summary.
    if (user!.role !== "super_admin" && !(await canAdminAccessBatch(db, user!.profileId, user!.role, batchId))) return forbidden();

    // Registered students in this batch (profile complete).
    const { data: students } = await db
      .from("profiles")
      .select("id")
      .eq("batch_id", batchId)
      // Enrolment, not role: an admin can also be an enrolled student — see services/enrollment.ts
      .eq("is_profile_complete", true);
    const studentIds = (students ?? []).map((s) => s.id);
    const registered = studentIds.length;

    // Best payment status per student (one payment counts once).
    let paid = 0, awaitingReview = 0;
    if (studentIds.length > 0) {
      const { data: payRows } = await db
        .from("payments")
        .select("student_id, status, created_at")
        .in("student_id", studentIds)
        .order("created_at", { ascending: false });
      const best = bestPaymentPerStudent(payRows ?? []);
      for (const row of Object.values(best)) {
        if (row.status === "approved") paid++;
        else if (row.status === "submitted" || row.status === "reupload_requested") awaitingReview++;
      }
    }

    const notPaid = Math.max(0, registered - paid - awaitingReview);

    return ok({
      batch_id: batchId,
      registered,
      paid,
      awaiting_review: awaitingReview,
      not_paid: notPaid,
      min_seats: PETITION_MIN_SEATS,
      seats_remaining: Math.max(0, PETITION_MIN_SEATS - registered),
    });
  } catch (e) {
    console.error("[api/admin/batch-summary]", e);
    return serverError();
  }
}
