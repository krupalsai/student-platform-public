import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";

const PAGE_SIZE = 50;

/**
 * GET /api/notifications — the student's own in-app inbox.
 *
 * Reads the same student_notifications rows every notifyStudent call logs,
 * newest first. ?count=1 returns only the unread count (for the nav badge).
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();
    const countOnly = new URL(req.url).searchParams.get("count") === "1";

    if (countOnly) {
      const { count } = await db
        .from("student_notifications")
        .select("id", { count: "exact", head: true })
        .eq("student_id", user!.profileId)
        .is("read_at", null);
      return ok({ unread: count ?? 0 });
    }

    const { data, error: qErr } = await db
      .from("student_notifications")
      .select("id, type, message, sent_at, read_at")
      .eq("student_id", user!.profileId)
      .order("sent_at", { ascending: false })
      .limit(PAGE_SIZE);
    if (qErr) return serverError("Could not load notifications.");

    const rows = data ?? [];
    return ok({
      notifications: rows,
      unread: rows.filter((r: any) => !r.read_at).length,
    });
  } catch (e) {
    console.error("[api/notifications] GET failed:", (e as Error).message);
    return serverError();
  }
}

/**
 * POST /api/notifications — mark as read.
 * Body: { all: true } or { ids: [...] }. Scoped to the student's own rows.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const body = await req.json().catch(() => ({}));
    const db = createServiceClient();
    let q = db
      .from("student_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("student_id", user!.profileId)
      .is("read_at", null);
    if (Array.isArray(body.ids) && body.ids.length) {
      q = q.in("id", body.ids.slice(0, 200));
    }
    const { error: uErr } = await q;
    if (uErr) return serverError("Could not mark notifications read.");
    return ok({ marked: true });
  } catch (e) {
    console.error("[api/notifications] POST failed:", (e as Error).message);
    return serverError();
  }
}
