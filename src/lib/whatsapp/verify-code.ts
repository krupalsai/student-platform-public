/**
 * "VERIFY" on WhatsApp means "let me into the app".
 *
 * The bot replies with a 6-digit login code, never a link. The student
 * reads the code from WhatsApp, types it into the app's login-code field,
 * and is signed in — the same code the app's own "send code" request
 * issues (see app-login.ts: issueLoginOtp), so shape, lifetime (5 min)
 * and hashing live in one place.
 *
 * Why a reply, not a proactive send: WhatsApp only delivers free-form
 * text inside the 24-hour window after the recipient's own last message
 * (outside it Meta accepts the send and silently drops it, error
 * 131047). VERIFY *is* the student's message, so the window is open by
 * construction when this reply goes out — the code cannot be silently
 * dropped. The app's "Try again" button exists for exactly this: it
 * opens WhatsApp with VERIFY pre-filled, the student taps Send, and the
 * bot replies with the code. There used to be a one-time sign-in link
 * here instead (the 9 Nov 2026 rebuild removed it): a link was the old
 * workaround for the window, and it opened in Chrome instead of the
 * installed app.
 *
 * Safe by construction: the code goes ONLY to the number the message came
 * from, and WhatsApp itself proves who sent it (the webhook is signature
 * checked). A 6-digit code has the OTP attempt rules on the verify side
 * (5 wrong guesses per phone per 15 min on /api/auth/app-login/verify).
 * Minting a code here is capped per number (MAX_CODES below) so it
 * cannot be used to flood anyone.
 *
 * The code survives the output guard (bot-guard.ts) by construction: no
 * credential pattern matches a bare 6-digit number — the "long hex
 * secret" pattern needs 32+ hex chars, which is what ate the old 64-hex
 * link key on 8 Nov 2026. The code is still passed as preserve, the same
 * belt-and-braces the link fix used, so a future pattern can never eat it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/services/students";
import { checkRateLimit } from "@/lib/rate-limit";
import { createProfileForPendingToken, issueLoginOtp } from "@/lib/app-login";
import { findPendingRegistrationTokenForPhone } from "@/lib/registration-token";
import { sendWhatsAppText } from "@/lib/whatsapp/client";

/** The text the app's "get my code on WhatsApp" button pre-fills. */
export const VERIFY_MESSAGE_RE = /^\s*verify[\s.!]*$/i;

const STAFF_ROLES = ["admin", "viewer", "super_admin"];
/** Codes one number may ask for this way: a handful is a retry, more is abuse. */
const MAX_CODES = 5;
const WINDOW_SEC = 10 * 60;

export interface VerifyDeps {
  /** Sends a WhatsApp text. Injected so the handler can be tested without Meta. */
  send?: (to: string, text: string, opts?: { preserve?: string[] }) => Promise<boolean>;
}

/**
 * Handles an inbound "VERIFY". Returns true when the message was dealt with
 * (a code was sent, or the sender was refused), false when it should carry on
 * to the normal bot — e.g. a number we know nothing about.
 */
export async function replyWithCodeToVerify(
  db: SupabaseClient,
  waFrom: string,
  opts: { isAdmin: boolean },
  deps: VerifyDeps = {},
): Promise<boolean> {
  const send = deps.send ?? sendWhatsAppText;
  const phone = normalizePhone(waFrom);
  if (phone.length !== 10) return false;

  const { data: found } = await db
    .from("profiles")
    .select("id, role, is_profile_complete")
    .eq("phone", phone)
    .maybeSingle();
  let profile = found;

  // A live registration link, if this number has one (even a finished student
  // keeps theirs until they pay, and may reopen it).
  const token = await findPendingRegistrationTokenForPhone(db, phone);

  // A number that only holds a link has no profile yet; give it the same
  // incomplete one requestAppLoginOtp would, so the code also works on /login.
  if (!profile && token) profile = await createProfileForPendingToken(db, phone, token.id);

  if (!profile && !token) return false; // a number we know nothing about — let the bot answer normally

  // Same rule as requestAppLoginOtp: staff roles log in only if the number is
  // also an active WhatsApp admin.
  if (profile && STAFF_ROLES.includes(profile.role) && !opts.isAdmin) {
    await send(waFrom, "This WhatsApp number isn't authorized for admin access.");
    return true;
  }

  const rl = await checkRateLimit(db, `verify-code:${phone}`, MAX_CODES, WINDOW_SEC);
  if (!rl.allowed) {
    await send(waFrom, "You've asked for several login codes in a short time. Please wait a few minutes, then try again.");
    return true;
  }

  // A login code needs a profile; a number that only holds a registration
  // link has none yet — let the normal bot flow handle it (registration).
  if (!profile) return false;

  try {
    const otp = await issueLoginOtp(db, profile.id);
    const ok = await send(
      waFrom,
      `🔐 *Your Student Platform login code: ${otp}*\n\nType this code in the Student App to sign in. It expires in 5 minutes. Do not share this code with anyone.`,
      { preserve: [otp] },
    );
    // Last four digits only — the log should help find a failure, not list numbers.
    if (!ok) console.error(`[verify-code] the login code reply to ***${phone.slice(-4)} was not accepted by WhatsApp`);
  } catch (e) {
    console.error("[verify-code] could not issue a login code", (e as Error).message);
    await send(waFrom, "We couldn't create your login code just now. Please try again in a minute.");
  }
  return true;
}
