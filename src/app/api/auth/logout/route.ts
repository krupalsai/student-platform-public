import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { hashToken } from "@/lib/token";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Revoke BOTH credentials this browser may hold. A device that has an old
  // localStorage token next to a newer cookie (or vice versa) would otherwise
  // keep one session alive after the student pressed Logout.
  const cookieToken = req.cookies.get("sp_session")?.value?.trim() || "";
  const bearerToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
    || (req.headers.get("x-session-token") ?? "").trim();
  const hashes = [...new Set([cookieToken, bearerToken].filter(Boolean))].map(hashToken);

  if (hashes.length) {
    // Logout must not leave the browser waiting indefinitely on a slow DB call.
    // Bound revocation work, but always return the cookie-clearing response.
    try {
      await Promise.race([
        createServiceClient().from("sessions").delete().in("token_hash", hashes),
        new Promise((resolve) => setTimeout(() => resolve(null), 1800)),
      ]);
    } catch { /* Clearing the browser cookie is still mandatory. */ }
  }

  const response = NextResponse.json({ success: true });
  response.cookies.set("sp_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
