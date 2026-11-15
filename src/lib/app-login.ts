import { sessionTtlDays } from "@/lib/session";
import { SupabaseClient } from "@supabase/supabase-js";
import { randomInt, createHash } from "crypto";
import { normalizePhone } from "@/lib/services/students";
import { generateToken } from "@/lib/token";
import { attachProfileToToken, findPendingRegistrationTokenForPhone } from "@/lib/registration-token";
import { getWhatsAppDisplayNumber } from "@/lib/whatsapp/client";
import { getAdmin, bootstrapAdmins, normaliseAdminPhone } from "@/lib/whatsapp/admin-service";
import { sendPushMessage } from "@/lib/push/client";
import {
  getPushSubscriptionsForStudent,
  touchPushSubscription,
  markPushSubscriptionFailed,
  deletePushSubscriptionByEndpoint,
} from "@/lib/push/subscriptions";

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

function hashOtp(otp: string) {
  return createHash("sha256").update(otp).digest("hex");
}

function makeOtp() {
  return String(randomInt(100000, 1000000));
}

/**
 * Creates a fresh login code for a profile and returns it, to be delivered
 * exactly once. Shared by the app's "send code" request below and by the
 * WhatsApp "VERIFY" reply (whatsapp/verify-code.ts), so a code's shape,
 * lifetime and hashing live in one place. `code` lets the VERIFY reply store
 * the SAME value for the registration screen too (see verify-code.ts).
 */
export async function issueLoginOtp(db: SupabaseClient, profileId: string, code?: string): Promise<string> {
  const otp = code ?? makeOtp();
  const { error } = await db.from("app_login_otps").insert({
    profile_id: profileId,
    otp_hash: hashOtp(otp),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
  });
  if (error) throw error;
  return otp;
}

/**
 * A number that holds a live registration link but has no profile yet gets an
 * INCOMPLETE one, attached to the link, so it can sign in (the recovery path
 * in requestAppLoginOtp: a student installs the app from the link, later opens
 * it from the home screen without the link, and lands on the login screen).
 * Nothing is granted by this — the person still has to prove the phone with a
 * code. Returns the profile, or null when it could not be created or found.
 * Shared with the WhatsApp "VERIFY" reply (whatsapp/verify-code.ts).
 */
export async function createProfileForPendingToken(db: SupabaseClient, phone: string, tokenId: string) {
  const { data: created, error: createError } = await db
    .from("profiles")
    .insert({ phone, role: "student", is_profile_complete: false })
    .select("id, role, is_profile_complete, phone")
    .single();
  if (!createError && created) {
    await attachProfileToToken(db, tokenId, created.id);
    return created;
  }

  // Another request may have created the profile at the same time.
  const { data: existing } = await db
    .from("profiles")
    .select("id, role, is_profile_complete, phone")
    .eq("phone", phone)
    .maybeSingle();
  if (!existing) return null;
  await attachProfileToToken(db, tokenId, existing.id);
  return existing;
}

export async function buildVerifyLink(): Promise<string | null> {
  const number = await getWhatsAppDisplayNumber();
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent("VERIFY")}`;
}

/**
 * Registration start link: opens WhatsApp with "Register" pre-filled.
 * "Register" is the bot's own registration trigger — the router tells
 * students "Reply *Register* to get started" and rule-intent maps it to the
 * register menu, which issues the registration token/link. Registration
 * starts ONLY via the bot; there is no self-service website registration,
 * so this link must never be replaced with a website form URL.
 */
export async function buildRegisterLink(): Promise<string | null> {
  const number = await getWhatsAppDisplayNumber();
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent("Register")}`;
}

/**
 * Push result with delivery certainty. `ambiguous` is the 9 Nov 2026 fix:
 * a send that TIMED OUT (network_error — no HTTP answer at all) may still
 * land, because the timeout only abandons waiting for it; the underlying
 * web-push request keeps running and FCM can accept it seconds later. The
 * owner saw exactly this: the page said "the code didn't arrive" while the
 * notification with the code was sitting in his shade. A timed-out send is
 * therefore NOT a failed delivery — the OTP must be kept (it stays valid
 * for 5 minutes) so the code that arrives still verifies. Only a
 * definitive failure (no subscriptions, or every subscription dead /
 * rejected by the push service) deletes the OTP and falls back to WhatsApp.
 */
type PushAttempt = { ok: boolean; ambiguous: boolean };

async function tryPushDelivery(
  db: SupabaseClient,
  studentId: string,
  otp: string
): Promise<PushAttempt> {
  let subs;
  try {
    subs = await getPushSubscriptionsForStudent(db, studentId);
  } catch (e) {
    console.error("[app-login] push subscription lookup failed", e);
    return { ok: false, ambiguous: false };
  }
  if (!subs.length) return { ok: false, ambiguous: false };

  // Sends run in parallel, not one after another: with a per-send timeout
  // the sequential loop could take N x timeout before answering, which is
  // what made the login page's own 15s send timeout fire first.
  const results = await Promise.all(
    subs.map(async (sub) => {
      const result = await sendPushMessage(sub, {
        title: "Student Platform login code",
        body: `Your login code is ${otp}. It expires in 5 minutes.`,
        tag: "login-otp",
      });
      return { sub, result };
    }),
  );
  let ambiguous = false;
  for (const { sub, result } of results) {
    if (result.ok) {
      await touchPushSubscription(db, sub.id);
      return { ok: true, ambiguous: false };
    }
    // 404/410 (endpoint gone) or 401/403 (VAPID mismatch after a key
    // rotation): this subscription can never receive from this server
    // again, so delete it — retrying it only shows the student another
    // red error first. Anything else is transient: mark it failed.
    if (result.dead) {
      await deletePushSubscriptionByEndpoint(db, sub.endpoint);
    } else {
      await markPushSubscriptionFailed(db, sub.id, result.reason);
    }
    // A timeout means no answer came back — the push may still have been
    // accepted after the timeout fired. Never treat it as "didn't arrive".
    if (result.reason === "network_error") ambiguous = true;
  }
  return { ok: false, ambiguous };
}

/**
 * Sends the code to THIS device only: the browser's own push endpoint, and
 * only when that endpoint is already stored against this account (it was
 * subscribed earlier from a signed-in session of this same student). That is
 * what makes in-app delivery safe — anyone can type a phone number, but only
 * a device that was already logged in as that student can receive its code.
 * A first login on a new device has no such endpoint: push to any linked
 * device is tried next, and if that fails the student gets the code on
 * WhatsApp by messaging VERIFY (see requestAppLoginOtp below).
 */
async function tryPushToThisDevice(
  db: SupabaseClient,
  studentId: string,
  endpoint: string,
  otp: string
): Promise<PushAttempt> {
  const { data: sub } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("student_id", studentId)
    .eq("endpoint", endpoint)
    .maybeSingle();
  if (!sub) return { ok: false, ambiguous: false };
  const result = await sendPushMessage(sub, {
    title: "Your login code",
    body: `${otp} is your Student Platform login code. It expires in 5 minutes. Do not share it.`,
    tag: "login-otp",
    url: "/login",
    otp,
  });
  if (result.ok) {
    await touchPushSubscription(db, sub.id);
    return { ok: true, ambiguous: false };
  }
  // Same as tryPushDelivery above: a 404/410 or a 401/403 means this
  // subscription is permanently dead for this server — delete it.
  if (result.dead) await deletePushSubscriptionByEndpoint(db, sub.endpoint);
  else await markPushSubscriptionFailed(db, sub.id, result.reason);
  // A timeout is ambiguous, not failed — the notification may still land.
  return { ok: false, ambiguous: result.reason === "network_error" };
}

export async function requestAppLoginOtp(
  db: SupabaseClient,
  rawPhone: string,
  opts: { deviceEndpoint?: string | null } = {}
) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false as const, error: "Enter a valid mobile number." };

  let { data: profile, error: profileError } = await db
    .from("profiles")
    .select("id, role, is_profile_complete, phone")
    .eq("phone", phone)
    .maybeSingle();

  if (profileError) throw profileError;

  // Recovery path: a student can install the PWA from a registration link and
  // later open it from the home-screen icon. In that case the browser may no
  // longer have the registration URL/token, so the old login flow incorrectly
  // reported "not registered" even though a valid registration token existed.
  // Create only an INCOMPLETE profile here. The student must still prove
  // possession of the phone with the OTP below before a login session is made.
  if (!profile) {
    const pendingToken = await findPendingRegistrationTokenForPhone(db, phone);
    if (pendingToken) {
      profile = await createProfileForPendingToken(db, phone, pendingToken.id);
      if (!profile) return { ok: false as const, error: "Could not start registration. Please reopen your registration link." };
    }
  }

  // Structured flag (same pattern as whatsappCodeFallback below), so the login
  // page can offer a registration start without matching on this wording.
  if (!profile) return { ok: false as const, error: "This mobile number is not registered.", notRegistered: true as const };

  if (["admin", "viewer", "super_admin"].includes(profile.role)) {
    await bootstrapAdmins(db);
    const admin = await getAdmin(db, normaliseAdminPhone(phone));
    // Structured flag (same anti-enumeration rule as notRegistered below):
    // the wording would prove this number belongs to a staff account. The
    // route answers with the same generic WhatsApp fallback instead; the
    // WhatsApp VERIFY reply still tells the admin plainly.
    if (!admin) return { ok: false as const, error: "This account is not authorized for admin access.", notAuthorized: true as const };
  }

  const { data: recent } = await db
    .from("app_login_otps")
    .select("created_at")
    .eq("profile_id", profile.id)
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recent && Date.now() - new Date(recent.created_at).getTime() < RESEND_COOLDOWN_MS) {
    // Structured flag (same anti-enumeration rule as notRegistered below): a
    // "wait 60 seconds" reply would prove a code was just issued for this
    // number, i.e. that it is registered. The route answers with the same
    // generic WhatsApp fallback instead.
    return { ok: false as const, error: "Please wait 60 seconds before requesting another code.", cooldown: true as const };
  }

  const otp = await issueLoginOtp(db, profile.id);

  // Delivery order: push to this device, then push to any linked device.
  // There is NO WhatsApp send here, on purpose: WhatsApp only delivers
  // inside the 24-hour window after the student messages the bot, and a
  // free-form text sent outside it is accepted by Meta and then silently
  // dropped (error 131047) — the old code treated that "accepted" as
  // delivered, so students saw "code sent" and got nothing. The student
  // reopens the window by tapping "Try again" in the app, which opens
  // WhatsApp with VERIFY pre-filled; the bot's VERIFY reply (see
  // whatsapp/verify-code.ts) is a reply to that message, so the window is
  // open by construction and the code arrives. There is no SMS fallback
  // any more — Fast2SMS was deleted 26 Oct 2026 (its key was rejected
  // 401 and it never delivered a code) and Twilio was never configured.
  // If no push accepts the code, the OTP is deleted below and the caller
  // gets a clean failure flagged for the WhatsApp-code path — but ONLY
  // when the failure is definitive. A push send that TIMED OUT is not a
  // failure: the timeout abandons waiting, the send itself keeps running
  // and FCM can still deliver it, so the OTP is kept and the caller is
  // told the code was sent. Deleting it would leave the student holding
  // a code the server no longer accepts (seen live 9 Nov 2026: the page
  // said "didn't arrive" while the notification with the code was in
  // his shade).
  let ambiguous = false;
  if (opts.deviceEndpoint) {
    const here = await tryPushToThisDevice(db, profile.id, opts.deviceEndpoint, otp);
    if (here.ok) return { ok: true as const, channel: "app" as const };
    ambiguous = here.ambiguous;
  }

  const viaPush = await tryPushDelivery(db, profile.id, otp);
  if (viaPush.ok) return { ok: true as const, channel: "push" as const };
  ambiguous = ambiguous || viaPush.ambiguous;
  if (ambiguous) {
    return { ok: true as const, channel: "push" as const };
  }

  await db.from("app_login_otps").delete().eq("otp_hash", hashOtp(otp));
  return {
    ok: false as const,
    error: "Couldn't send the code as a notification — get it on WhatsApp instead.",
    // Structured, so the login screen offers the get-the-code-on-WhatsApp
    // path without matching on the wording above (that mismatch once left
    // the button dead).
    whatsappCodeFallback: true as const,
  };
}

export async function verifyAppLoginOtp(db: SupabaseClient, rawPhone: string, otp: string) {
  const phone = normalizePhone(rawPhone);
  if (!phone || !/^\d{6}$/.test(otp)) return null;

  const { data: profile } = await db
    .from("profiles")
    .select("id, role, is_profile_complete, phone")
    .eq("phone", phone)
    .maybeSingle();
  if (!profile) return null;

  if (["admin", "viewer", "super_admin"].includes(profile.role)) {
    await bootstrapAdmins(db);
    const admin = await getAdmin(db, normaliseAdminPhone(phone));
    if (!admin) return null;
  } else if (profile.role !== "student") {
    return null;
  }

  const { data: row } = await db
    .from("app_login_otps")
    .select("id, profile_id, expires_at, used_at")
    .eq("profile_id", profile.id)
    .eq("otp_hash", hashOtp(otp))
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;

  const { data: consumed } = await db
    .from("app_login_otps")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  if (!consumed) return null;

  const { raw, hashed } = generateToken();
  const { error } = await db.from("sessions").insert({
    student_id: profile.id,
    token_hash: hashed,
    expires_at: new Date(Date.now() + sessionTtlDays(profile.role) * 86400000).toISOString(),
  });
  if (error) {
    // The code was correct and has already been consumed, so answering
    // "Invalid login code" would be a lie — and the student would burn
    // another code on a retry that hits the same failure. Surface it as
    // a server error instead, with the real cause in the log.
    console.error("[app-login] session insert failed after OTP verify", error);
    throw new Error("SESSION_CREATE_FAILED");
  }

  return {
    token: raw,
    profile_id: profile.id,
    role: profile.role,
    is_profile_complete: profile.is_profile_complete,
  };
}
