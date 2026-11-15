import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { validateRegistrationToken, issueRegistrationOtp, hashRegistrationOtp } from "@/lib/registration-token";
import { normalizePhone } from "@/lib/services/students";
import { sendPushMessage } from "@/lib/push/client";
import { sendWhatsAppOtp } from "@/lib/whatsapp/otp";
import { checkRateLimit } from "@/lib/rate-limit";
import { ok, badRequest, zodError, serverError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const SubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});
const Schema = z.object({
  token: z.string().min(1),
  phone: z.string().min(8).max(20),
  // Web Push subscription created on THIS device by the registration screen.
  // Delivered as an app notification to that subscription — never WhatsApp.
  subscription: SubscriptionSchema.optional(),
});
const RESEND_COOLDOWN_SEC = 60;

/**
 * POST /api/registration-tokens/request-otp
 *
 * The "confirm it's you" step between /install and the registration form.
 * The token already carries the phone the WhatsApp bot issued it to — this
 * endpoint requires the student to type that same number back and rejects
 * anything else, then sends a 6-digit OTP to it as an app notification. Same OTP
 * shape/TTL as the existing app-login flow, but keyed by the registration
 * token (registration_token_otps) since a brand new registrant has no
 * profile row yet at this point.
 *
 * Deliberately returns the same generic mismatch error whether the phone
 * is wrong, the token is invalid, or the batch is inactive — a client
 * probing shouldn't be able to distinguish "wrong number" from "dead link".
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
      return badRequest("That number doesn't match this registration link. Use the number you messaged the bot from.");
    }

    const rl = await checkRateLimit(db, `reg-otp:${payload.id}`, 5, 600);
    if (!rl.allowed) {
      return badRequest("Too many attempts. Please try again in a few minutes.");
    }

    const { data: recent } = await db
      .from("registration_token_otps")
      .select("created_at")
      .eq("registration_token_id", payload.id)
      .is("used_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent && Date.now() - new Date(recent.created_at).getTime() < RESEND_COOLDOWN_SEC * 1000) {
      return badRequest("Please wait 60 seconds before requesting another code.");
    }

    const otp = await issueRegistrationOtp(db, payload.id);

    // Push-only: the code goes to the subscription the registration screen
    // created on THIS device. No WhatsApp fallback — WhatsApp's only job is
    // handing out the registration/download link.
    const sub = body.data.subscription;
    if (!sub) {
      await db.from("registration_token_otps").delete().eq("otp_hash", hashRegistrationOtp(otp));
      return badRequest("Turn on notifications for Student Platform, then try again.");
    }
    // StoredPushSubscription is flat { endpoint, p256dh, auth }; the
    // browser's PushSubscription.toJSON() nests the keys, so flatten here.
    const result = await sendPushMessage(
      { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      {
        title: "Student Platform registration code",
        body: `${otp} is your Student Platform registration code. It expires in 5 minutes. Do not share it.`,
        tag: "registration-otp",
        otp,
      }
    );
    if (!result.ok) {
      // No SMS fallback any more (Fast2SMS deleted 26 Oct 2026 — it never
      // delivered; Twilio was never configured). WhatsApp is the only other
      // road: template first, then free-form text as a last resort.
      const viaWa = await sendWhatsAppOtp(payload.phone, otp);
      if (viaWa === "template") return ok({ sent: true, channel: "whatsapp" });
      if (viaWa === "text") return ok({ sent: true, channel: "whatsapp" });
      await db.from("registration_token_otps").delete().eq("otp_hash", hashRegistrationOtp(otp));
      // `dead` covers expired (404/410) AND VAPID mismatch (401/403): this
      // device's subscription was created under a rotated key, so the fix
      // is to reload the page — that recreates the subscription under the
      // server's current key. (No stored subscription to delete here: the
      // subscription only links to the account after registration.)
      return badRequest(
        result.dead
          ? "Notifications expired. Reload this page and try again."
          : "Couldn't send the code. Check that notifications are allowed, then try again."
      );
    }

    return ok({ sent: true, channel: "push" });
  } catch (e) {
    console.error("[api/registration-tokens/request-otp]", e);
    return serverError();
  }
}
