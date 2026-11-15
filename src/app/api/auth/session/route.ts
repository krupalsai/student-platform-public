import { NextRequest, NextResponse } from "next/server";
import { getSession, readSessionToken, setSessionCookie } from "@/lib/session";

// Role/removal state must always be read live — never cached.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * GET /api/auth/session
 * Validates the Bearer token from Authorization header and returns
 * the current role + profile state from the database.
 * Used by HomeRedirect to avoid trusting stale localStorage role values.
 */
export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) {
    return NextResponse.json({ success: false }, { status: 401 });
  }
  const res = NextResponse.json({
    success: true,
    data: {
      role: user.role,
      is_profile_complete: user.isProfileComplete,
      profile_id: user.profileId,
      // Lets the client tell a plain admin apart from one who is ALSO enrolled
      // in a batch, and so may open the student view (see route-decision.ts).
      batch_id: user.batchId,
    },
  });
  // Silently migrate legacy localStorage-token users to the cookie session, and
  // keep the cookie's lifetime sliding in step with the DB session.
  const { raw } = readSessionToken(req);
  if (raw) setSessionCookie(res, raw, user.role);
  return res;
}
