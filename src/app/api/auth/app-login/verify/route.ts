import { setSessionCookie } from "@/lib/session";
import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { verifyAppLoginOtp } from "@/lib/app-login";
import { normalizePhone } from "@/lib/services/students";
import { isLockedOut, recordFailedAttempt, clearFailedAttempts } from "@/lib/rate-limit";
import { ok, badRequest, serverError, tooManyRequests, zodError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const Schema = z.object({ phone: z.string().min(8).max(20), otp: z.string().length(6) });

/**
 * Brute-force budget for the login OTP.
 *
 * The code is 6 digits and lives 5 minutes, so without a cap an attacker who
 * knows a phone number — including an admin's — can simply guess against it,
 * as fast as this endpoint will answer, for as long as they like. Serverless
 * concurrency means "as fast as it will answer" is a lot. This cap is what
 * makes the OTP worth its 6 digits.
 *
 * Two independent buckets, both of which must be under budget:
 *   - per phone: stops guessing at one specific account (the admin-takeover case)
 *   - per IP:    stops one attacker spraying single guesses across many phones,
 *                which would otherwise stay under every per-phone cap
 *
 * Only FAILED attempts are counted, and a success clears the phone bucket, so
 * a legitimate person mistyping a digit or logging in from several devices is
 * never locked out. Both checks fail CLOSED — see rate-limit.ts.
 */
const MAX_ATTEMPTS_PER_PHONE = 5;
const MAX_ATTEMPTS_PER_IP = 20;
const WINDOW_SEC = 15 * 60;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0]!.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: NextRequest) {
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const db = createServiceClient();

    // Bucket on the normalized phone so "+91 98…", "098…" and "98…" can't be
    // used as three separate budgets for the same account.
    const phoneKey = `otp_verify_phone:${normalizePhone(body.data.phone) || body.data.phone}`;
    const ipKey = `otp_verify_ip:${clientIp(req)}`;

    if (
      (await isLockedOut(db, phoneKey, MAX_ATTEMPTS_PER_PHONE, WINDOW_SEC)) ||
      (await isLockedOut(db, ipKey, MAX_ATTEMPTS_PER_IP, WINDOW_SEC))
    ) {
      return tooManyRequests("Too many incorrect codes. Please wait 15 minutes, then request a new code.");
    }

    const result = await verifyAppLoginOtp(db, body.data.phone, body.data.otp);
    if (!result) {
      await recordFailedAttempt(db, phoneKey);
      await recordFailedAttempt(db, ipKey);
      return badRequest("Invalid or expired login code.");
    }

    await clearFailedAttempts(db, phoneKey);

    // Persist the authenticated session in an HttpOnly cookie so reopening the
    // PWA does not trigger another WhatsApp OTP. Keep the response token for
    // existing client code, but the cookie is the durable browser session.
    const response = ok(result);
    setSessionCookie(response, result.token, result.role);
    return response;
  } catch (e) {
    console.error("[api/auth/app-login/verify]", e);
    return serverError();
  }
}
