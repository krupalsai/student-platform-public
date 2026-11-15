import { NextRequest } from "next/server";
import { requireSession, requireSuperAdmin } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";
import { logStudentEvent } from "@/lib/student-events";
import { ok, forbidden, serverError } from "@/lib/api-response";

const EVENT = "linkedin.post_clicked";

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return forbidden();

  try {
    const db = createServiceClient();
    const { data: profile, error: pErr } = await db
      .from("profiles")
      .select("id, role, college, batch_id")
      .eq("id", user.profileId)
      .maybeSingle();
    if (pErr) throw pErr;

    // Measure student engagement only; admin/staff testing must not pollute the data.
    if (!profile || profile.role !== "student") return ok({ tracked: false, reason: "not_a_student" });

    await logStudentEvent(db, {
      student_id: profile.id,
            batch_id: profile.batch_id ?? user.batchId,
      college: profile.college ?? null,
      event_type: EVENT,
      page: "/dashboard",
      metadata: { destination: "linkedin" },
    });
    return ok({ tracked: true });
  } catch (e) {
    console.error("LinkedIn analytics POST error:", e);
    return serverError();
  }
}

export async function GET(req: NextRequest) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();
    const p = req.nextUrl.searchParams;
    const days = Math.min(Math.max(parseInt(p.get("days") ?? "30", 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const { data: events, error: eErr } = await db
      .from("student_events")
      .select("id, student_id, created_at")
      .eq("event_type", EVENT)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (eErr) throw eErr;

    const rawRows = events ?? [];
    const studentIds = [...new Set(rawRows.map((r: any) => r.student_id).filter(Boolean))];
    const { data: profiles, error: profileErr } = studentIds.length
      ? await db.from("profiles").select("id, role, full_name, roll_number, college").in("id", studentIds)
      : { data: [], error: null };
    if (profileErr) throw profileErr;

    const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
    const rows = rawRows
      .map((r: any) => ({ ...r, profile: profileMap.get(r.student_id) }))
      .filter((r: any) => r.profile?.role === "student");

    const uniqueStudents = new Set(rows.map((r: any) => r.student_id).filter(Boolean));
    const byCollege: Record<string, number> = {};
    for (const row of rows as any[]) {
      const college = row.profile?.college || "Unknown";
      byCollege[college] = (byCollege[college] ?? 0) + 1;
    }

    return ok({
      days,
      total_taps: rows.length,
      unique_students: uniqueStudents.size,
      by_college: byCollege,
      recent: rows.slice(0, 50).map((r: any) => ({
        id: r.id,
        created_at: r.created_at,
        college: r.profile?.college ?? "Unknown",
        student: {
          name: r.profile?.full_name ?? "Unknown student",
          roll: r.profile?.roll_number ?? "",
        },
      })),
      verification_note: "This app can verify that a student opened the LinkedIn post. It cannot verify the LinkedIn reaction/comment itself.",
    });
  } catch (e) {
    console.error("LinkedIn analytics GET error:", e);
    return serverError();
  }
}
