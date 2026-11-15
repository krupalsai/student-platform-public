import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { getCollegeIds } from "@/lib/services/colleges";
import { adminBatchIds } from "@/lib/authz";

export async function GET(req: NextRequest) {
  const { user, error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  const p = req.nextUrl.searchParams;
  const college = p.get("college");
  const db = createServiceClient();
  // Batch isolation: normal admins/viewers only see their assigned batches
  // (super_admin → null = all batches; no assignments → empty analytics).
  const assignedBatchIds = await adminBatchIds(db, user!.profileId, user!.role);
  if (assignedBatchIds !== null && assignedBatchIds.length === 0) {
    return ok({
      total: 0, total_collected: 0,
      paid: { count: 0, students: [] }, review: { count: 0, students: [] },
      not_paid: { count: 0, students: [] }, rejected: { count: 0, students: [] },
      batch_stats: [],
    });
  }
  // Validated against the live colleges table, not a hardcoded ["GNIT","GNITC"]
  // list — that silently fell back to showing EVERY college's data for a
  // college added later (e.g. ?college=BIET), which reads as "filter worked"
  // while actually ignoring it. Same trap as items #101/#107/#114/#118.
  const validCollege = college && (await getCollegeIds(db)).includes(college) ? college : null;

  try {
    // 1. All students (flat, no nested join)
    let studentsQ = db
      .from("profiles")
      .select("id, full_name, phone, college, branch, roll_number, batches!profiles_batch_id_fkey(name)")
      // Anyone enrolled in a batch, whatever their role. // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
      .not("batch_id", "is", null)
      .eq("is_profile_complete", true)
      .order("created_at", { ascending: false });
    if (validCollege) studentsQ = studentsQ.eq("college", validCollege);
    if (assignedBatchIds !== null) studentsQ = studentsQ.in("batch_id", assignedBatchIds);
    const { data: students, error: sErr } = await studentsQ;
    if (sErr) throw sErr;

    const allStudents = students ?? [];
    const studentIds  = allStudents.map(s => s.id);

    // 2. All payments for these students in one query
    const { data: allPayments, error: pErr } = studentIds.length > 0
      ? await db.from("payments")
          .select("student_id, status, amount")
          .in("student_id", studentIds)
      : { data: [], error: null };
    if (pErr) throw pErr;

    // Build a map: student_id → best status
    // Priority: approved > submitted > reupload_requested > rejected > pg_pending > pending
    const STATUS_PRIORITY: Record<string, number> = {
      approved: 6, submitted: 5, reupload_requested: 4,
      rejected: 3, pg_failed: 2, pg_pending: 1, pending: 0,
    };
    const bestStatus: Record<string, string> = {};
    const collectedByStudent: Record<string, number> = {};
    for (const pay of allPayments ?? []) {
      const sid = pay.student_id;
      const cur = bestStatus[sid];
      const newPriority = STATUS_PRIORITY[pay.status] ?? 0;
      const curPriority = cur ? (STATUS_PRIORITY[cur] ?? 0) : -1;
      if (newPriority > curPriority) bestStatus[sid] = pay.status;
      if (pay.status === "approved") {
        collectedByStudent[sid] = (collectedByStudent[sid] ?? 0) + Number(pay.amount ?? 0);
      }
    }

    const totalCollected = Object.values(collectedByStudent).reduce((a, b) => a + b, 0);

    // 3. Categorise each student by their best payment status
    const fmt = (s: any) => ({
      id: s.id, name: s.full_name ?? "Unknown",
      phone: s.phone ?? "", college: s.college ?? "",
      branch: s.branch ?? "", roll: s.roll_number ?? "",
      batch: (s.batches as any)?.name ?? "",
    });

    const paid:     any[] = [];
    const review:   any[] = [];
    const notPaid:  any[] = [];
    const rejected: any[] = [];

    for (const s of allStudents) {
      const status = bestStatus[s.id] ?? "none";
      if (status === "approved")                                  paid.push(fmt(s));
      else if (status === "submitted")                            review.push(fmt(s));
      else if (status === "rejected" || status === "reupload_requested") rejected.push(fmt(s));
      else /* pending, pg_pending, pg_failed, none */             notPaid.push(fmt(s));
    }

    // 4. Batch stats
    let batchQ = db.from("batches")
      .select("id, name, college, fee_amount")
      .order("created_at", { ascending: false });
    if (validCollege) batchQ = batchQ.eq("college", validCollege);
    if (assignedBatchIds !== null) batchQ = batchQ.in("id", assignedBatchIds);
    const { data: batches } = await batchQ;

    const batchStats = await Promise.all((batches ?? []).map(async b => {
      // is_profile_complete=true — see batches/route.ts for the same fix and why.
      const { data: batchStudents } = await db.from("profiles")
        .select("id")
        .eq("batch_id", b.id).eq("is_profile_complete", true); // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
      const ids = (batchStudents ?? []).map(s => s.id);
      const paidCount = ids.filter(id => bestStatus[id] === "approved").length;
      return {
        id: b.id, name: b.name, college: b.college, fee_amount: Number(b.fee_amount),
        student_count: ids.length,
        paid_count: paidCount,
        not_paid_count: ids.length - paidCount,
      };
    }));

    return ok({
      total: allStudents.length,
      total_collected: totalCollected,
      paid:     { count: paid.length,     students: paid     },
      review:   { count: review.length,   students: review   },
      not_paid: { count: notPaid.length,  students: notPaid  },
      rejected: { count: rejected.length, students: rejected },
      batch_stats: batchStats.filter(b => b.student_count > 0),
    });

  } catch (e) {
    console.error("Analytics error:", e);
    return serverError();
  }
}
