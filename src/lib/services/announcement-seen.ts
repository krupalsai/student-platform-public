/**
 * Announcement "seen" tracking.
 *
 * Students' phones report which announcement cards scrolled into view via
 * POST /api/announcements/seen; each view lands in student_events as an
 * "announcement.viewed" event with the announcement id in metadata — no
 * schema change needed. The admin screen counts DISTINCT student_id per
 * announcement, so one student opening the page five times still counts
 * once.
 *
 * NOTE: the import below is relative (not "@/...") on purpose — this module
 * is covered by tests/announcement-seen.test.ts, and node's test runner
 * cannot resolve the "@" path alias.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logStudentEvent } from "../student-events.ts";

export interface ViewerProfile {
  id: string;
  batch_id: string | null;
  college: string | null;
}

/** Record that a student viewed these announcements. Best-effort. */
export async function recordAnnouncementViews(
  db: SupabaseClient,
  profile: ViewerProfile,
  announcementIds: string[],
): Promise<number> {
  let tracked = 0;
  for (const id of announcementIds) {
    await logStudentEvent(db, {
      student_id: profile.id,
      batch_id: profile.batch_id,
      college: profile.college,
      event_type: "announcement.viewed",
      page: "/announcements",
      metadata: { announcement_id: id },
    });
    tracked++;
  }
  return tracked;
}

/**
 * Distinct student viewers per announcement id.
 * Unknown ids and failed queries come back as 0 — the admin chip shows a
 * number, never an error state.
 */
export async function countAnnouncementViews(
  db: SupabaseClient,
  announcementIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await Promise.all(
    announcementIds.map(async (id) => {
      const { data, error } = await db
        .from("student_events")
        .select("student_id")
        .eq("event_type", "announcement.viewed")
        .eq("metadata->>announcement_id", id);
      if (error || !data) {
        counts[id] = 0;
        return;
      }
      counts[id] = new Set(
        (data as Array<{ student_id: string }>).map((r) => r.student_id),
      ).size;
    }),
  );
  return counts;
}
