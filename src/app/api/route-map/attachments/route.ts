import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, dbError } from "@/lib/api-response";
import { hasApprovedPayment } from "@/lib/services/payments";
import { canReadRouteMap, isStaff } from "@/lib/authz";

/**
 * Route Map attachments a student can see — their own college's, plus any
 * marked "all". The college comes from their profile, never from the query
 * string, so one student cannot read another college's material.
 *
 * Authorisation is server-side, not a UI condition. This endpoint used to
 * answer any logged-in session, so a registered-but-unpaid student could read
 * every court/petition document uploaded for their college by calling it
 * directly — regardless of what the dashboard chose to render. The check now
 * lives here, where it cannot be skipped. Staff pass through for admin
 * preview.
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  const db = createServiceClient();

  // super_admin gets the free pass; everyone else must have a verified
  // payment (see canReadRouteMap). A plain 'admin' no longer bypasses this,
  // so hiding the Route Map tile can't be walked around by calling the API.
  const verified = user!.role === "super_admin" ? true : await hasApprovedPayment(db, user!.profileId);
  if (!canReadRouteMap(user!.role, verified)) return forbidden();

  const { data: profile } = await db
    .from("profiles").select("college").eq("id", user!.profileId).single();

  const college = profile?.college ?? null;

  /**
   * A staff account legitimately has no college of its own — the super_admin
   * was deliberately stripped of its batch and college so it would stop being
   * counted as a student (item #103). That made this endpoint return an empty
   * list for the one account that is allowed to see everything, so the admin's
   * own Route Map preview showed the hardcoded steps with every uploaded
   * document silently missing — and the client swallows fetch failures by
   * design, so there was nothing on screen to explain it.
   *
   * Staff already read and write every college's attachments on
   * /admin/route-map, so showing them all here grants nothing new. A student
   * without a college still gets an empty list: for them a missing college
   * means an unfinished registration, not "show me everything".
   */
  if (!college) {
    if (!isStaff(user!.role as Parameters<typeof isStaff>[0])) return ok([]);
    const { data: all, error: allErr } = await db
      .from("route_map_attachments")
      .select("id, title, description, file_url, file_name, file_type, kind, step_id, sort_order")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (allErr) return dbError("api/route-map/attachments", allErr);
    return ok(all ?? []);
  }

  const { data, error: err } = await db
    .from("route_map_attachments")
    .select("id, title, description, file_url, file_name, file_type, kind, step_id, sort_order")
    .in("college", [college, "all"])
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (err) return dbError("api/route-map/attachments", err);
  return ok(data ?? []);
}
