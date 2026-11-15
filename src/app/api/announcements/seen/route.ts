import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";
import { recordAnnouncementViews } from "@/lib/services/announcement-seen";
import { ok, forbidden, badRequest, serverError } from "@/lib/api-response";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * POST /api/announcements/seen — a student reports which announcement cards
 * actually scrolled into view on their phone.
 *
 * Body: { announcement_ids: string[] }
 *
 * Each id lands in student_events as an "announcement.viewed" event (no
 * schema change needed), and the admin side counts DISTINCT student_id so
 * repeat views never inflate the number.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return forbidden();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body.");
  }
  const rawIds = (body as { announcement_ids?: unknown } | null)?.announcement_ids;
  if (!Array.isArray(rawIds)) return badRequest("announcement_ids must be an array.");

  const ids = [...new Set(
    rawIds.filter((x): x is string => typeof x === "string" && UUID_RE.test(x))
  )].slice(0, 200);
  if (ids.length === 0) return ok({ tracked: 0 });

  try {
    const db = createServiceClient();
    const { data: profile } = await db
      .from("profiles")
      .select("id, role, college, batch_id")
      .eq("id", user.profileId)
      .maybeSingle();

    // Measure student engagement only; admin/staff testing must not pollute
    // the seen counts (same rule as api/analytics/linkedin).
    if (!profile || profile.role !== "student") return ok({ tracked: 0 });

    const tracked = await recordAnnouncementViews(
      db,
      { id: profile.id, batch_id: profile.batch_id ?? null, college: profile.college ?? null },
      ids,
    );
    return ok({ tracked });
  } catch (err) {
    console.error("[api/announcements/seen]", err);
    return serverError();
  }
}
