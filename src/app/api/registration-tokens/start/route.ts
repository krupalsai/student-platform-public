import { NextResponse } from "next/server";

/**
 * DISABLED — this endpoint bootstrapped a full session from just a
 * registration-link token, with NO phone/OTP confirmation at all.
 *
 * That directly defeated the "confirm it's you" security boundary
 * `/api/registration-tokens/request-otp` + `verify-otp` exist specifically
 * to enforce (see that route's own comment: "a stolen/forwarded link is
 * useless without also controlling the WhatsApp number it was issued to").
 * A registration link is exactly the kind of thing that gets forwarded,
 * bookmarked, reopened weeks later, or lands on the wrong device (items
 * #101/#133/#146/#166 all document this happening in practice) — so this
 * route was a live, working authentication bypass: anyone holding a leaked
 * or forwarded link could mint a session for that student without proving
 * they control the phone number at all.
 *
 * The frontend has not called this route since verify-otp shipped (confirmed
 * via a full-repo grep — register/page.tsx only references it in a comment).
 * It was left in "for a tab already mid-flow before the deploy," a
 * transitional exception that should never have stayed live indefinitely.
 * Found and disabled in a full security audit (2026-09-27) — do not restore
 * without re-adding the same OTP check verify-otp already enforces.
 */
export async function POST() {
  return NextResponse.json(
    { success: false, error: "This link needs to be verified first. Please open your registration link again." },
    { status: 410 },
  );
}
