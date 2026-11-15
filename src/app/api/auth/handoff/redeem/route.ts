import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { generateToken, hashToken } from "@/lib/token";
import { sessionTtlDays, setSessionCookie } from "@/lib/session";
import { dbError, zodError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// Redeems a one-time session handoff token (9 Nov 2026 — gray → canonical
// domain). Single-use: the handoff row is DELETED and only the caller whose
// delete actually removed a row proceeds. A token that was already
// redeemed, expired, or never existed deletes nothing and is rejected.
// On success a fresh, full-lifetime session is minted for the same
// profile, the session cookie is set, and the new raw token is returned
// for the client to store in localStorage — so the user lands on the
// canonical domain signed in, with no manual sign-in step.

const Schema = z.object({ token: z.string().min(1) });

export async function POST(req: NextRequest) {
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return zodError(body.error);

  const db = createServiceClient();
  const tokenHash = hashToken(body.data.token);

  // Delete-then-proceed is the single-use enforcement: only one redeem can
  // ever remove the row. The expiry check means a stale token is dead
  // even if it was never redeemed.
  const { data: consumed, error: deleteError } = await db
    .from("sessions")
    .delete()
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .select("student_id")
    .maybeSingle();
  if (deleteError) return dbError("api/auth/handoff/redeem", deleteError);
  if (!consumed?.student_id) {
    return NextResponse.json(
      { success: false, error: "Invalid or expired handoff.", code: "INVALID_HANDOFF" },
      { status: 401 },
    );
  }

  const { data: profile } = await db
    .from("profiles")
    .select("id, role")
    .eq("id", consumed.student_id)
    .maybeSingle();
  if (!profile) {
    return NextResponse.json(
      { success: false, error: "Invalid or expired handoff.", code: "INVALID_HANDOFF" },
      { status: 401 },
    );
  }

  const { raw, hashed } = generateToken();
  const { error: insertError } = await db.from("sessions").insert({
    student_id: profile.id,
    token_hash: hashed,
    expires_at: new Date(Date.now() + sessionTtlDays(profile.role) * 86400000).toISOString(),
  });
  if (insertError) return dbError("api/auth/handoff/redeem", insertError);

  const res = NextResponse.json({ success: true, data: { token: raw } });
  setSessionCookie(res, raw, profile.role);
  return res;
}
