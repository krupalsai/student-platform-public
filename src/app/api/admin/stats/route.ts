import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { getActiveColleges } from "@/lib/services/colleges";

export async function GET(req: NextRequest) {
  const { error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();

    // Colleges are loaded dynamically — this route no longer hardcodes
    // GNIT/GNITC anywhere. Adding a new college row to the `colleges`
    // table is enough; no code change needed.
    const colleges = await getActiveColleges(db);

    const [
      { count: total_students },
      { count: complete_profiles },
      { count: payments_approved },
      { count: payments_pending },
      { data: collectedData },
      { count: total_batches },
    ] = await Promise.all([
      db.from("profiles").select("*", { count: "exact", head: true }).not("batch_id", "is", null).eq("is_profile_complete", true), // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
      db.from("profiles").select("*", { count: "exact", head: true }).eq("is_profile_complete", true),
      db.from("payments").select("*", { count: "exact", head: true }).eq("status", "approved"),
      db.from("payments").select("*", { count: "exact", head: true }).eq("status", "submitted"),
      db.from("payments").select("amount").eq("status", "approved"),
      db.from("batches").select("*", { count: "exact", head: true }).neq("status", "archived"),
    ]);

    const total_collected = (collectedData ?? []).reduce(
      (sum: number, p: any) => sum + Number(p.amount ?? 0), 0
    );

    // Per-college breakdown — one query pair per college, built dynamically
    const by_college = await Promise.all(
      colleges.map(async (c) => {
        const [{ count: students }, { count: batches }, { count: activeBatches }] = await Promise.all([
          db.from("profiles").select("*", { count: "exact", head: true })
            .not("batch_id", "is", null).eq("is_profile_complete", true).eq("college", c.id), // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
          db.from("batches").select("*", { count: "exact", head: true })
            .neq("status", "archived").eq("college", c.id),
          // "Running" = has at least one batch currently active — used by the
          // admin home college-pill row to show only colleges running a batch
          // right now (item #169). Deliberately doesn't affect `batches`
          // above, which stays the total non-archived count (active + closed
          // + full + pending_setup) — that total is what shows once an admin
          // has already picked a college, where both running AND closed
          // batches must still appear.
          db.from("batches").select("*", { count: "exact", head: true })
            .eq("status", "active").eq("college", c.id),
        ]);
        return { id: c.id, name: c.name, students: students ?? 0, batches: batches ?? 0, has_active_batch: (activeBatches ?? 0) > 0 };
      })
    );

    return ok({
      total_students: total_students ?? 0,
      complete_profiles: complete_profiles ?? 0,
      payments_approved: payments_approved ?? 0,
      payments_pending: payments_pending ?? 0,
      total_collected,
      total_batches: total_batches ?? 0,
      by_college,
    });
  } catch (err) { console.error("[api/admin/stats]", err); return serverError(); }
}
