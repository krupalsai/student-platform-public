import { setSessionCookie } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createHash } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { validateRegistrationToken } from "@/lib/registration-token";
import { normalizePhone } from "@/lib/services/students";
import { bootstrapSessionFromToken } from "@/lib/services/registration-bootstrap";
import { isLockedOut, recordFailedAttempt, clearFailedAttempts } from "@/lib/rate-limit";
import { ok, badRequest, zodError, serverError, tooManyRequests } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const Schema = z.object({ token: z.string().min(1), phone: z.string().min(8).max(20), otp: z.string().min(6).max(6) });

/**
 * Same brute-force budget as the login OTP (see auth/app-login/verify). The
 * OTP here is what makes a forwarded/leaked registration link useless without
 * also controlling the WhatsApp number it was issued to — the stated purpose
 * in this file's own header. Guessing 6 digits unthrottled defeats exactly
 * that, so the cap is part of the defence, not an add-on. Only failed
 * attempts count; success clears the bucket. Fails CLOSED.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_SEC = 15 * 60;

function hashOtp(otp: string) {
  return createHash("sha256").update(otp).digest("hex");
}

/**
 * POST /api/registration-tokens/verify-otp
 *
 * Second half of the phone-confirmation step (see request-otp). Verifies
 * the OTP, then does exactly what /api/registration-tokens/start used to
 * do directly — find-or-create the profile and mint a session — via the
 * shared bootstrapSessionFromToken() helper. /start is intentionally no
 * longer called by the frontend: this is now the only door into a
 * registration session, so a stolen/forwarded link is useless without
 * also controlling the WhatsApp number it was issued to.
 */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const db = createServiceClient();
    const payload = await validateRegistrationToken(db, body.data.token);
    if (!payload) {
      return NextResponse.json({ success: false, error: "This registration link is no longer valid." }, { status: 410 });
    }

    const entered = normalizePhone(body.data.phone);
    if (!entered || entered !== payload.phone) {
      return badRequest("That number doesn't match this registration link.");
    }

    if (!/^\d{6}$/.test(body.data.otp)) return badRequest("Enter the 6-digit code.");

    // Keyed on the token id, which is what the OTP actually guards — one
    // budget per issued registration link.
    const bucketKey = `reg_otp_verify:${payload.id}`;
    if (await isLockedOut(db, bucketKey, MAX_ATTEMPTS, WINDOW_SEC)) {
      return tooManyRequests("Too many incorrect codes. Please wait 15 minutes, then request a new one.");
    }

    const { data: row } = await db
      .from("registration_token_otps")
      .select("id, expires_at, used_at")
      .eq("registration_token_id", payload.id)
      .eq("otp_hash", hashOtp(body.data.otp))
      .is("used_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      await recordFailedAttempt(db, bucketKey);
      return badRequest("That code is invalid or has expired. Request a new one.");
    }

    const { data: consumed } = await db
      .from("registration_token_otps")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("used_at", null)
      .select("id")
      .maybeSingle();
    if (!consumed) return badRequest("That code is invalid or has expired. Request a new one.");

    await clearFailedAttempts(db, bucketKey);

    const result = await bootstrapSessionFromToken(db, payload);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 410 });
    }

    const res = ok(result.data);
    // Same persistent-login cookie every other login path sets.
    setSessionCookie(res, result.data.token, result.data.role);
    return res;
  } catch (e) {
    console.error("[api/registration-tokens/verify-otp]", e);
    return serverError();
  }
}
