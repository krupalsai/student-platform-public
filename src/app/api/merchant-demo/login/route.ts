import { sessionTtlDays, setSessionCookie } from "@/lib/session";
import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { audit } from "@/lib/audit";
import { generateToken } from "@/lib/token";
import { createServiceClient } from "@/lib/supabase/server";
import { ok, notFound, forbidden, serverError } from "@/lib/api-response";

/**
 * Payment-gateway merchant-verification reviewers (Cashfree, and any
 * future gateway's own KYC process — item #186 wanted this generic, not
 * Cashfree-specific) have no way to log in normally: this app has no
 * static username/password, only phone + WhatsApp OTP, and a cold number
 * with no profile/registration token on file just gets "not registered"
 * (app-login.ts). Rather than hand out a real student's number, this
 * mints a session for ONE dedicated, pre-provisioned demo profile
 * (phone 0000000001 — a 10-digit sequence that can never collide with a
 * real Indian mobile number, which all start 6-9) already scoped to its
 * own isolated batch/college (id "PGDEMO", colleges.active=false so it
 * never appears in any real picker, WhatsApp match, or by_college stats
 * breakdown — only the platform-wide unscoped tiles on /admin tick up by
 * one harmless row). The demo batch's ₹1 fee lets a reviewer reach a real
 * checkout, and the profile starts incomplete so /register shows the
 * actual registration form, not a shortcut.
 *
 * Entirely inert without MERCHANT_DEMO_KEY set in Vercel — that env var
 * IS the on/off switch; there is no separate admin toggle. Unset it once
 * a review is done to close this door.
 */
const DEMO_PHONE = "0000000001";

export async function POST(req: NextRequest) {
  const configuredKey = process.env.MERCHANT_DEMO_KEY;
  if (!configuredKey) return notFound();

  try {
    const body = await req.json().catch(() => null);
    const key = typeof body?.key === "string" ? body.key : "";

    const a = Buffer.from(key);
    const b = Buffer.from(configuredKey);
    const matches = a.length === b.length && timingSafeEqual(a, b);
    if (!matches) return forbidden();

    const db = createServiceClient();
    const { data: profile } = await db
      .from("profiles")
      .select("id, role, is_profile_complete")
      .eq("phone", DEMO_PHONE)
      .maybeSingle();
    if (!profile) return notFound("Demo profile not provisioned.");

    const { raw, hashed } = generateToken();
    const { error } = await db.from("sessions").insert({
      student_id: profile.id,
      token_hash: hashed,
      expires_at: new Date(Date.now() + sessionTtlDays(profile.role) * 86400000).toISOString(),
    });
    if (error) return serverError();

    await audit("session.created", "profile", profile.id, { via: "merchant_demo" }, profile.id, profile.role);

    const res = ok({ token: raw, role: profile.role, is_profile_complete: profile.is_profile_complete });
    setSessionCookie(res, raw, profile.role);
    return res;
  } catch (e) {
    console.error("[api/merchant-demo/login]", e);
    return serverError();
  }
}
