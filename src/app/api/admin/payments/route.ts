import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, serverError, dbError } from "@/lib/api-response";
import { adminBatchIds } from "@/lib/authz";

const RETIRED_MANUAL_STATES = new Set(["submitted", "rejected", "reupload_requested"]);

export async function GET(req: NextRequest) {
  const { user, error } = await requireViewerOrAdmin(req); if (error) return forbidden();
  const p = req.nextUrl.searchParams;
  const db = createServiceClient();

  // Batch isolation: normal admins only see their assigned batches
  const assignedBatchIds = await adminBatchIds(db, user!.profileId, user!.role);

  if (p.get("counts") === "true") {
    const batchId = p.get("batch_id") ?? "";
    try {
      let cq = db.from("admin_payment_queue").select("payment_status");
      if (batchId) cq = cq.eq("batch_id", batchId);
      if (assignedBatchIds !== null) {
        if (assignedBatchIds.length === 0) return ok({});
        cq = cq.in("batch_id", assignedBatchIds);
      }
      const { data, error: err } = await cq;
      if (err) return dbError("api/admin/payments", err);
      const counts: Record<string, number> = {};
      for (const row of data ?? []) {
        if (RETIRED_MANUAL_STATES.has(String(row.payment_status))) continue;
        counts[row.payment_status] = (counts[row.payment_status] ?? 0) + 1;
      }
      return ok(counts);
    } catch (err) { console.error("[api/admin/payments]", err); return serverError(); }
  }

  const status = p.get("status") ?? "submitted", q = p.get("q") ?? "", college = p.get("college") ?? "", batchId = p.get("batch_id") ?? "";
  const page = Math.max(1, parseInt(p.get("page") ?? "1")), limit = 500, from = (page - 1) * limit;

  // The old Pending/Rejected/Reupload tabs were manual-UPI workflows.
  // Cashfree payments are gateway-driven and auto-approved by webhook, so
  // those queues are intentionally empty now.
  if (RETIRED_MANUAL_STATES.has(status)) {
    return ok({ payments: [], total: 0, page, limit });
  }

  try {
    let query = db.from("admin_payment_queue").select("*", { count: "exact" });
    if (status !== "all") query = query.eq("payment_status", status);
    if (college) query = query.eq("college", college);
    if (batchId) query = query.eq("batch_id", batchId);
    if (assignedBatchIds !== null) {
      if (assignedBatchIds.length === 0) return ok({ payments: [], total: 0, page, limit });
      query = query.in("batch_id", assignedBatchIds);
    }
    if (q) query = query.or(`full_name.ilike.%${q}%,roll_number.ilike.%${q}%,utr_number.ilike.%${q}%,phone.ilike.%${q}%`);
    const { data, count, error: err } = await query.order("submitted_at", { ascending: true }).range(from, from + limit - 1);
    if (err) return dbError("api/admin/payments", err);
    const visible = (data ?? []).filter((row: any) => !RETIRED_MANUAL_STATES.has(String(row.payment_status)));
    return ok({ payments: visible, total: visible.length, page, limit });
  } catch (err) { console.error("[api/admin/payments]", err); return serverError(); }
}
