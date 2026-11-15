import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, notFound, serverError } from "@/lib/api-response";
import { bestPaymentPerStudent } from "@/lib/services/payments";
import { computeBatchStats } from "@/lib/services/batch-stats";
import { canAdminAccessBatch } from "@/lib/authz";

/**
 * GET /api/admin/batches/[id]/stats
 *
 * Returns numbers scoped to ONE specific batch only — real students in
 * that batch, their payment status, and the amount collected from them.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  const { id: batchId } = await params;

  try {
    const db = createServiceClient();

    const { data: batch } = await db
      .from("batches")
      .select("id, name, slug, college, fee_amount, status, case_type, case_number, case_year, case_status_url")
      .eq("id", batchId)
      .maybeSingle();
    if (!batch) return notFound("Batch");

    // Batch isolation: only a super_admin or an admin assigned to this
    // batch may read its stats (same gate as admin/batches/[id]).
    if (user!.role !== "super_admin" && !(await canAdminAccessBatch(db, user!.profileId, user!.role, batchId))) return forbidden();

    // The student card counts every completed profile enrolled in this
    // batch, whatever their current role is. A person can subsequently be
    // promoted to admin without losing their enrolment or their
    // already-approved payment, so the card and the payment statistics must
    // share one denominator: ALL completed profiles in the batch. Counting
    // only role === "student" dropped batch admins from the card (GNIT
    // Batch 2 showed 23 while the list showed 25) while their payments
    // still counted — a mixed denominator. The counting itself lives in
    // computeBatchStats (src/lib/services/batch-stats.ts) so it is
    // unit-testable without a database.
    const { data: enrolledProfiles } = await db
      .from("profiles")
      .select("id")
      .eq("batch_id", batchId)
      .eq("is_profile_complete", true);

    const enrolledIds = (enrolledProfiles ?? []).map((p) => p.id);

    let payments: { student_id: string; status: string; amount: number | null; created_at: string }[] = [];
    if (enrolledIds.length > 0) {
      const { data } = await db
        .from("payments")
        .select("student_id, status, amount, created_at")
        .in("student_id", enrolledIds)
        .order("created_at", { ascending: false });
      payments = data ?? [];
    }

    const stats = computeBatchStats(
      enrolledProfiles ?? [],
      bestPaymentPerStudent(payments),
    );

    return ok({
      batch,
      ...stats,
    });
  } catch (e) {
    return serverError();
  }
}
