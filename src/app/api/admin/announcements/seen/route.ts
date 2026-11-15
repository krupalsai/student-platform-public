import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { countAnnouncementViews } from "@/lib/services/announcement-seen";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { adminBatchIds } from "@/lib/authz";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/announcements/seen?ids=<comma-separated announcement ids>
 *
 * Returns { [announcement_id]: distinct_student_viewer_count }.
 *
 * Counts DISTINCT student_id per announcement, so one student opening the
 * page five times still counts once. Counts are returned only for
 * announcements this admin is allowed to see (same batch-scope rule as
 * GET /api/admin/announcements).
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error || !user) return forbidden();

  const raw = (req.nextUrl.searchParams.get("ids") ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const ids = [...new Set(raw.filter(id => UUID_RE.test(id)))].slice(0, 50);
  if (ids.length === 0) return ok({});

  try {
    const db = createServiceClient();

    // Same visibility rule as the announcements list: a scoped admin only
    // gets counts for announcements inside their assigned batches.
    const assignedBatchIds = await adminBatchIds(db, user.profileId, user.role);
    if (assignedBatchIds !== null && assignedBatchIds.length === 0) return ok({});
    let vis = db.from("announcements").select("id");
    if (assignedBatchIds !== null) vis = vis.in("batch_id", assignedBatchIds);
    const { data: visible } = await vis;
    const visibleIds = new Set((visible ?? []).map(v => v.id as string));
    const allowed = ids.filter(id => visibleIds.has(id));
    if (allowed.length === 0) return ok({});

    return ok(await countAnnouncementViews(db, allowed));
  } catch (err) {
    console.error("[api/admin/announcements/seen]", err);
    return serverError();
  }
}
