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
  const college   = p.get("college");
  const eventType = p.get("event_type");
  const days      = Math.min(parseInt(p.get("days") ?? "7", 10), 90);

  const db = createServiceClient();
  // Batch isolation: normal admins/viewers only see events in their assigned
  // batches (super_admin → null = all; no assignments → empty).
  const assignedBatchIds = await adminBatchIds(db, user!.profileId, user!.role);
  if (assignedBatchIds !== null && assignedBatchIds.length === 0) {
    return ok({
      events: [], type_counts: {},
      funnel: {
        "registration.started": 0, "registration.completed": 0,
        "payment.page_opened": 0, "payment.initiated": 0,
        "payment.submitted": 0, "payment.approved": 0,
      },
      days,
    });
  }

  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    let q = db
      .from("student_events")
      .select("id, student_id, event_type, page, college, batch_id, metadata, created_at, profiles(full_name, phone, roll_number)")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    // Validated against the live colleges table, not a hardcoded list —
    // see api/admin/analytics/route.ts for why (items #101/#107/#114/#118).
    if (college && (await getCollegeIds(db)).includes(college)) q = q.eq("college", college);
    if (eventType) q = q.eq("event_type", eventType);
    if (assignedBatchIds !== null) q = q.in("batch_id", assignedBatchIds);

    const { data: events, error: eErr } = await q;
    if (eErr) throw eErr;

    // Event type counts for the filter bar
    let countsQ = db
      .from("student_events")
      .select("event_type")
      .gte("created_at", since);
    if (assignedBatchIds !== null) countsQ = countsQ.in("batch_id", assignedBatchIds);
    const { data: counts } = await countsQ;

    const typeCounts: Record<string, number> = {};
    for (const row of counts ?? []) {
      typeCounts[row.event_type] = (typeCounts[row.event_type] ?? 0) + 1;
    }

    // Funnel: unique students per key event
    const funnelEvents = [
      "registration.started", "registration.completed",
      "payment.page_opened", "payment.initiated", "payment.submitted", "payment.approved",
    ];
    const funnelCounts: Record<string, number> = {};
    for (const et of funnelEvents) {
      let fq = db
        .from("student_events")
        .select("student_id", { count: "exact", head: true })
        .eq("event_type", et)
        .gte("created_at", since);
      if (assignedBatchIds !== null) fq = fq.in("batch_id", assignedBatchIds);
      const { count } = await fq;
      funnelCounts[et] = count ?? 0;
    }

    return ok({
      events: (events ?? []).map(e => ({
        id: e.id,
        event_type: e.event_type,
        page: e.page,
        college: e.college,
        metadata: e.metadata,
        created_at: e.created_at,
        student: {
          id: e.student_id,
          name: (e.profiles as any)?.full_name ?? "Unknown",
          phone: (e.profiles as any)?.phone ?? "",
          roll: (e.profiles as any)?.roll_number ?? "",
        },
      })),
      type_counts: typeCounts,
      funnel: funnelCounts,
      days,
    });
  } catch (e) {
    console.error("Student analytics error:", e);
    return serverError();
  }
}
