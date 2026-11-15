import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * GET /r/[code]
 *
 * Short registration link. Deliberately does NOT look up the token here —
 * it just forwards the short code straight to /register?token=<code>, so
 * the student lands on registration in whatever browser opened the link.
 * No install step: the app works in the browser, and install is optional
 * (the browser itself offers it). Reuses the exact `token` query param
 * the registration page already reads, so the registration frontend
 * needed zero changes. validateRegistrationToken()
 * (registration-token.ts) is what actually recognizes and validates short
 * codes vs. legacy 64-char raw tokens; this route is a pure, stateless
 * redirect.
 *
 * Rate-limited per code (not per IP — a code is only ever meant to be
 * opened by one person a handful of times) as defense-in-depth. Not
 * strictly needed for brute-forcing (12-char base64url is ~2^72 possible
 * values) but matches this codebase's existing rate-limit conventions and
 * costs nothing.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  if (!code || !/^[A-Za-z0-9_-]{1,32}$/.test(code)) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const db = createServiceClient();
  const rl = await checkRateLimit(db, `short-link:${code}`, 20, 60);
  if (!rl.allowed) {
    return new NextResponse("Too many requests — please try again shortly.", { status: 429 });
  }

  const url = new URL("/register", req.url);
  url.searchParams.set("token", code);
  return NextResponse.redirect(url);
}
