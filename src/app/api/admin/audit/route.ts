import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError, dbError } from "@/lib/api-response";

export async function GET(req: NextRequest) {
  const { error } = await requireViewerOrSuperAdmin(req);
  if (error) return forbidden();

  const p = req.nextUrl.searchParams;
  const limit  = Math.min(parseInt(p.get("limit")  ?? "50"), 200);
  const offset = parseInt(p.get("offset") ?? "0");
  const filter = p.get("filter") ?? ""; // "payments" | "students" | "admins" | "sessions" | ""

  const db = createServiceClient();

  // --- Meaningful events from audit_logs (admin-written structured logs) ---
  // Exclude DB trigger noise: profiles_update caused by last_active_at heartbeat.
  // We detect noise by checking if the ONLY field that changed is last_active_at.
  let q = db.from("audit_logs")
    .select("id, actor_id, actor_role, action, target_type, target_id, meta, created_at, profiles(full_name, username)", { count: "exact" })
    .not("action", "in", "(profiles_update,payments_update)") // exclude raw trigger noise
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (filter === "payments")  q = q.ilike("action", "payment%");
  if (filter === "students")  q = q.or("action.ilike.profile%,action.ilike.student%");
  if (filter === "admins")    q = q.or("action.ilike.user%,action.ilike.batch%,actor_role.eq.admin");
  if (filter === "sessions")  q = q.eq("action", "session.created");

  const { data: logs, count, error: err } = await q;
  if (err) return dbError("api/admin/audit", err);

  // --- Session activity: derive from profiles.last_active_at per admin ---
  // Group sessions by reading from profiles directly for admin/viewer accounts.
  // batch_id/batches!profiles_batch_id_fkey(name) added so the page can show which batch an admin
  // belongs to when they're ALSO an enrolled student (item #103's overlap
  // case) — same select shape as api/admin/users/route.ts (item #185),
  // which already does this on the /admin/users screen.
  const { data: adminProfiles } = await db.from("profiles")
    .select("id, full_name, username, telegram_id, role, last_active_at, created_at, batch_id, batches!profiles_batch_id_fkey(name)")
    .in("role", ["admin", "viewer", "super_admin"])
    .order("last_active_at", { ascending: false });

  // --- Recent student activity (registrations + payments) from source tables ---
  const { data: recentStudents } = await db.from("profiles")
    .select("id, full_name, roll_number, college, created_at, is_profile_complete")
    .eq("role", "student")
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: recentPayments } = await db.from("payments")
    .select("id, student_id, status, amount, created_at, reviewed_at, phonepe_txn_id, profiles(full_name, roll_number, college)")
    .order("created_at", { ascending: false })
    .limit(30);

  return ok({
    logs: logs ?? [],
    total: count ?? 0,
    adminActivity: adminProfiles ?? [],
    recentStudents: recentStudents ?? [],
    recentPayments: recentPayments ?? [],
  });
}
