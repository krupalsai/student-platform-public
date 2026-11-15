import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { generateToken } from "@/lib/token";
import { ok, unauthorized, dbError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// One-time session handoff token (9 Nov 2026 — gray → canonical domain).
//
// The installed app still opens on the old gray domain, whose session
// (localStorage + cookie) does not transfer to the canonical domain
// (both are per-origin). This endpoint mints a short-lived token for the
// caller's current session; the /handoff page carries it to the canonical
// domain, where /api/auth/handoff/redeem exchanges it for a real session.
//
// Security shape:
//  - The token is 32 random bytes; only its SHA-256 hash is stored.
//  - It lives 5 minutes and is deleted the moment it is redeemed, so it
//    is single-use and cannot be replayed.
//  - It is validated server-side (looked up in the sessions table); the
//    canonical side never trusts the URL value on its own.
//  - The long-lived session token is NEVER in a URL — only this
//    short-lived handoff token is, and only for the one redirect.
//  - Note: the row is a normal sessions row, so for its 5-minute life it
//    would also pass as a session token. That window is the same length
//    as a login OTP and the token is deleted on redeem (or expires in
//    5 minutes if never redeemed), so the exposure is a same-device
//    redirect, single-use, minutes-long — not a standing credential.
const HANDOFF_TTL_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return unauthorized();

  const { raw, hashed } = generateToken();
  const db = createServiceClient();
  const { error: insertError } = await db.from("sessions").insert({
    student_id: user.profileId,
    token_hash: hashed,
    expires_at: new Date(Date.now() + HANDOFF_TTL_MS).toISOString(),
  });
  if (insertError) return dbError("api/auth/handoff/create", insertError);
  return ok({ token: raw });
}
