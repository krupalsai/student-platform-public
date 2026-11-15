import { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { generateToken } from "@/lib/token";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, notFound, dbError, serverError } from "@/lib/api-response";

// Preview sessions are short-lived (10 minutes) — long enough for an admin
// to look at one student's dashboard, short enough that a leaked/logged
// token isn't a standing way into that student's account.
const PREVIEW_TTL_MINUTES = 10;

/**
 * POST /api/admin/students/[id]/preview-session
 *
 * Issues a real, short-lived session token for the given student so an
 * admin can see their ACTUAL dashboard with real data — not a mockup —
 * via /dashboard?preview_token=<token>. Admin already has equivalent or
 * greater read access to this student everywhere else (Students page),
 * so this isn't a new capability, just a different, more honest way to
 * view the same thing: exactly what the student sees, not a description
 * of it. dashboard/page.tsx renders read-only whenever a preview_token is
 * present — no payment/discussion/profile mutation is reachable this way.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();

  try {
    const { id } = await ctx.params;
    const db = createServiceClient();

    const { data: target } = await db.from("profiles").select("id, full_name").eq("id", id).maybeSingle();
    // Full access for the admin: the target's role never blocks a preview.
    // (2026-11-14: a student with role "admin" on GNITC Batch 2 showed
    // in the dashboard picker but preview said "Student not found" — the old
    // role === "student" check. A super admin opens any profile; only a
    // missing profile is "not found".)
    if (!target) return notFound("Student");

    const { raw, hashed } = generateToken();
    const { error: insErr } = await db.from("sessions").insert({
      student_id: id,
      token_hash: hashed,
      expires_at: new Date(Date.now() + PREVIEW_TTL_MINUTES * 60_000).toISOString(),
    });
    if (insErr) return dbError("api/admin/students/[id]/preview-session", insErr);

    await audit("session.created", "profile", id, { via: "admin_preview", preview: true, previewed_by: user!.profileId }, user!.profileId, user!.role);

    return ok({ token: raw, expires_in_minutes: PREVIEW_TTL_MINUTES, student_name: target.full_name });
  } catch (e) {
    console.error("[api/admin/students/[id]/preview-session]", e);
    return serverError();
  }
}
