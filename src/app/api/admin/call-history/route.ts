import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { forbidden, ok, serverError, dbError } from "@/lib/api-response";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || user?.role !== "super_admin") return forbidden();

  const db = createServiceClient();
  const batchId = req.nextUrl.searchParams.get("batch_id")?.trim() || "";
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") || "100");
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100, 1), 200);

  try {
    let query = db
      .from("voice_calls")
      .select("id, student_id, batch_id, admin_id, reason, status, created_at, answered_at, ended_at, duration_secs, ended_by")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (batchId) query = query.eq("batch_id", batchId);

    const { data: calls, error: callError } = await query;
    if (callError) return dbError("api/admin/call-history", callError);

    const rows = calls ?? [];
    const studentIds = [...new Set(rows.map(c => c.student_id).filter(Boolean))];
    const profileIds = [...new Set([
      ...rows.map(c => c.student_id),
      ...rows.map(c => c.admin_id).filter(Boolean),
    ])] as string[];
    const batchIds = [...new Set(rows.map(c => c.batch_id).filter(Boolean))] as string[];

    const [{ data: profiles, error: profileError }, { data: batches, error: batchError }] = await Promise.all([
      profileIds.length
        ? db.from("profiles").select("id, full_name, phone, role").in("id", profileIds)
        : Promise.resolve({ data: [], error: null }),
      batchIds.length
        ? db.from("batches").select("id, name").in("id", batchIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (profileError) return dbError("api/admin/call-history profiles", profileError);
    if (batchError) return dbError("api/admin/call-history batches", batchError);

    const profileOf = new Map((profiles ?? []).map(p => [p.id, p]));
    const batchOf = new Map((batches ?? []).map(b => [b.id, b.name]));

    return ok({
      calls: rows.map(call => {
        const student = profileOf.get(call.student_id);
        const admin = call.admin_id ? profileOf.get(call.admin_id) : null;
        const callback = call.reason === "Admin callback";
        return {
          ...call,
          student_name: student?.full_name ?? "Student",
          student_phone: student?.phone ?? null,
          batch_name: call.batch_id ? batchOf.get(call.batch_id) ?? null : null,
          admin_name: admin?.full_name ?? null,
          direction: callback ? "callback" : "incoming",
        };
      }),
    });
  } catch (e) {
    console.error("[api/admin/call-history GET]", e);
    return serverError();
  }
}
