import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { adminBatchIds } from "@/lib/authz";

/**
 * GET /api/admin/notifications
 *
 * Powers the bell icon on the admin dashboard. There is no dedicated
 * notifications table and no FK relationship exists between payments
 * and profiles in this schema, so this derives everything live from
 * separate queries (payments, profiles, batches) rather than an
 * embedded Supabase join or audit_logs (which only had a single row
 * ever logged and can't be trusted as a feed).
 *
 * Returns two kinds of items, newest first:
 *   - payment: a student's payment was approved, with which batch
 *   - batch:   a batch, with how many students have joined so far
 *              and how many are still unpaid
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();

    // Batch isolation: normal admins/viewers only see notifications for
    // their assigned batches (super_admin → null = all; no assignments → empty).
    const assignedBatchIds = await adminBatchIds(db, user!.profileId, user!.role);
    if (assignedBatchIds !== null && assignedBatchIds.length === 0) return ok({ items: [] });

    // 1. Recent approved payments — most recently updated first.
    const { data: recentPayments } = await db
      .from("payments")
      .select("id, student_id, amount, updated_at")
      .eq("status", "approved")
      .order("updated_at", { ascending: false })
      .limit(15);

    const paymentStudentIds = [...new Set((recentPayments ?? []).map(p => p.student_id))];

    // 2. Look up those students' names + batch in one query.
    const { data: paymentStudents } = paymentStudentIds.length > 0
      ? await db.from("profiles")
          .select("id, full_name, batch_id")
          .in("id", paymentStudentIds)
      : { data: [] as any[] };

    const batchIdsFromPayments = [...new Set((paymentStudents ?? []).map(s => s.batch_id).filter(Boolean))];

    const { data: paymentBatches } = batchIdsFromPayments.length > 0
      ? await db.from("batches").select("id, name, college").in("id", batchIdsFromPayments)
      : { data: [] as any[] };

    const studentById: Record<string, { full_name: string; batch_id: string | null }> = {};
    for (const s of paymentStudents ?? []) studentById[s.id] = s;
    const batchById: Record<string, { name: string; college: string }> = {};
    for (const b of paymentBatches ?? []) batchById[b.id] = b;

    const paymentItems = (recentPayments ?? [])
      .map((p) => {
        const student = studentById[p.student_id];
        if (!student) return null;
        // Batch isolation: skip payments from batches outside the caller's assignments.
        if (assignedBatchIds !== null && (!student.batch_id || !assignedBatchIds.includes(student.batch_id))) return null;
        const batch = student.batch_id ? batchById[student.batch_id] : null;
        return {
          type: "payment" as const,
          id: p.id,
          timestamp: p.updated_at,
          student_name: student.full_name,
          batch_name: batch?.name ?? "No batch",
          college: batch?.college ?? null,
          amount: Number(p.amount ?? 0),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // 3. Recently created / active batches, each with a live paid count.
    let recentBatchesQ = db
      .from("batches")
      .select("id, name, college, fee_amount, created_at")
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(8);
    if (assignedBatchIds !== null) recentBatchesQ = recentBatchesQ.in("id", assignedBatchIds);
    const { data: recentBatches } = await recentBatchesQ;

    const batchItems = await Promise.all(
      (recentBatches ?? []).map(async (b) => {
        // is_profile_complete=true — same fix as the batches list/analytics/
        // admin-menu counts; abandoned registration attempts don't belong here.
        const { data: students } = await db
          .from("profiles")
          .select("id")
          .eq("batch_id", b.id)
          .eq("role", "student")
          .eq("is_profile_complete", true);
        const studentIds = (students ?? []).map(s => s.id);

        let paidCount = 0;
        if (studentIds.length > 0) {
          const { data: payments } = await db
            .from("payments")
            .select("student_id")
            .in("student_id", studentIds)
            .eq("status", "approved");
          paidCount = new Set((payments ?? []).map(p => p.student_id)).size;
        }

        return {
          type: "batch" as const,
          id: b.id,
          timestamp: b.created_at,
          batch_name: b.name,
          college: b.college,
          total_students: studentIds.length,
          paid_students: paidCount,
          not_paid_students: studentIds.length - paidCount,
        };
      })
    );

    // Merge both kinds into one feed, newest first.
    const merged = [...paymentItems, ...batchItems]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 20);

    return ok({ items: merged });
  } catch (e) {
    return serverError();
  }
}
