import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const STATUSES = ["pending_admin", "answered", "open", "resolved"] as const;

/**
 * GET /api/admin/support?status=pending_admin|answered|open|resolved|all
 * In-app support threads, newest activity first, with the student's name,
 * college and batch. Default: cases waiting on the team (pending_admin).
 */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();
    const status = new URL(req.url).searchParams.get("status") ?? "pending_admin";
    let q = db
      .from("student_queries")
      .select("id, message, status, created_at, last_message_at, last_sender, escalated_at, admin_responded_at, student_id, college, profiles:student_id(full_name, phone, batches!profiles_batch_id_fkey(name))")
      .eq("source", "student_app")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(100);
    if (status !== "all" && (STATUSES as readonly string[]).includes(status)) q = q.eq("status", status);
    const { data, error: dbErr } = await q;
    if (dbErr) return serverError("Could not load support cases.");

    const { count: pending } = await db
      .from("student_queries").select("id", { count: "exact", head: true })
      .eq("source", "student_app").eq("status", "pending_admin");

    return ok({ threads: data ?? [], pending: pending ?? 0 });
  } catch (e) {
    console.error("[api/admin/support] GET", e);
    return serverError();
  }
}
