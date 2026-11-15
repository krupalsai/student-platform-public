import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, notFound, serverError } from "@/lib/api-response";
import { canAdminAccessBatch } from "@/lib/authz";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  try {
    const db = createServiceClient();
    // Try direct payment lookup from the view (contains all joined fields)
    const { data: row } = await db
      .from("admin_payment_queue")
      .select("*")
      .eq("payment_id", id)
      .maybeSingle();

    if (row) {
      // Batch isolation: the view row carries the payment's batch.
      // (Payments with no batch are super_admin-only: fail closed.)
      if (user!.role !== "super_admin") {
        const batchId = (row as any).batch_id ?? null;
        if (!batchId || !(await canAdminAccessBatch(db, user!.profileId, user!.role, batchId))) return forbidden();
      }
      return ok({ ...row });
    }

    // Fallback: raw payment row for very old records
    const { data: raw } = await db
      .from("payments")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (!raw) return notFound("Payment");
    // Batch isolation for the raw fallback: resolve the student's batch.
    if (user!.role !== "super_admin") {
      const { data: prof } = await db.from("profiles").select("batch_id").eq("id", (raw as any).student_id).maybeSingle();
      const batchId = (prof as any)?.batch_id ?? null;
      if (!batchId || !(await canAdminAccessBatch(db, user!.profileId, user!.role, batchId))) return forbidden();
    }
    return ok({
      ...raw,
      payment_id: raw.id,
      payment_status: raw.status,
    });
  } catch (err) { console.error("[api/admin/payments/[id]]", err);
    return serverError();
  }
}
