import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requestAppLoginOtp } from "@/lib/app-login";
import { normalizePhone } from "@/lib/services/students";
import { isLockedOut, recordAttempt } from "@/lib/rate-limit";
import { ok, badRequest, serverError, tooManyRequests, zodError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const Schema = z.object({
  phone: z.string().min(8).max(20),
  // This browser's own push endpoint, if notifications are on. Used only if
  // it is already linked to the account — never trusted on its own.
  device_endpoint: z.string().url().max(1000).optional().nullable(),
});

// Security fix (2026-10-26): the verify route already capped guessing
// (5 per phone, 20 per IP, per 15 min), but the REQUEST route had no cap
// at all — only the 60-second resend cooldown inside requestAppLoginOtp.
// Anyone who knew a number could keep a victim's phone buzzing with codes
// indefinitely. Same budgets as verify, counted only when a code was
// actually issued, so a failed/delivered-nowhere request never consumes
// the budget. Fails CLOSED like verify: if the rate-limit table itself
// errors, requests are blocked rather than unlimited. (The app request
// never sends WhatsApp messages — the code reaches WhatsApp only as a
// reply to the student's own VERIFY message — so the budget here is
// purely about push buzzing.)
const MAX_REQUESTS_PER_PHONE = 5;
const MAX_REQUESTS_PER_IP = 20;
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
    const phoneKey = `otp_request_phone:${normalizePhone(body.data.phone) || body.data.phone}`;
    const ipKey = `otp_request_ip:${clientIp(req)}`;

    if (
      (await isLockedOut(db, phoneKey, MAX_REQUESTS_PER_PHONE, WINDOW_SEC)) ||
      (await isLockedOut(db, ipKey, MAX_REQUESTS_PER_IP, WINDOW_SEC))
    ) {
      return tooManyRequests("Too many codes requested. Please wait 15 minutes, then try again.");
    }

    const result = await requestAppLoginOtp(db, body.data.phone, {
      deviceEndpoint: body.data.device_endpoint ?? null,
    });
    // Anti-enumeration (2026-11-09 audit): every failure that reveals account
    // state gets the SAME response as a plain push failure — same status,
    // same body, same text. Before this, `notRegistered` told a prober the
    // number isn't a student, the 60-second cooldown proved a code was just
    // issued for it, and the admin error proved it is a staff account. The
    // login page already handles this shape (calm banner + WhatsApp button),
    // and the bot still guides an unregistered number to registration, so
    // nothing the student sees changes. The per-IP budget is counted on
    // EVERY request now, not only issued codes — before this, a failed probe
    // never consumed the budget, so registration spraying was unlimited.
    // The per-phone budget still counts issued codes only, so nobody can
    // lock a victim's number out by spamming requests for it.
    await recordAttempt(db, ipKey);
    if (!result.ok) {
      if (
        result.whatsappCodeFallback ||
        result.notRegistered ||
        result.cooldown ||
        result.notAuthorized
      ) {
        return NextResponse.json(
          { success: false, error: "Couldn't send the code as a notification — get it on WhatsApp instead.", code: "BAD_REQUEST", fallback: "whatsapp_code" },
          { status: 400 },
        );
      }
      return badRequest(result.error);
    }
    // A code was actually issued — count it against the per-phone budget too.
    await recordAttempt(db, phoneKey);
    return ok({ sent: true, channel: result.channel });
  } catch (e) {
    console.error("[api/auth/app-login/request]", e);
    return serverError();
  }
}
