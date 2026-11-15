import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/payment-funnel-log
 *
 * Client-side code in the payment flow (register page, /pay/[slug],
 * /pay/redirect) cannot write to server logs directly, and every past
 * failure in this flow (QR bypassing the gateway, the redirect allowlist
 * silently rejecting a valid PhonePe URL, the fallback UI showing nothing
 * actionable) was invisible until a student sent a screenshot and someone
 * manually cross-referenced database timestamps to reconstruct what
 * happened.
 *
 * This endpoint exists purely so client-side code can report "something
 * unexpected happened here" and have it show up immediately in
 * `vercel logs` / the runtime-errors dashboard, the same way a real
 * server-side exception would. It intentionally does the bare minimum:
 * no auth required (a logged-out failure is still worth knowing about),
 * no DB write (Vercel's own log retention is enough for this), just a
 * structured console.error so it's queryable the same way every other
 * runtime error in this project already is.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { event, detail } = body ?? {};
    if (!event || typeof event !== "string") {
      return NextResponse.json({ success: false }, { status: 400 });
    }
    // Deliberately console.error (not .log) so this surfaces in the same
    // runtime-errors view as real exceptions, not buried in normal traffic.
    console.error(`[payment-funnel] ${event}`, JSON.stringify(detail ?? {}).slice(0, 2000));
    return NextResponse.json({ success: true });
  } catch (err) { console.error("[api/payment-funnel-log]", err);
    return NextResponse.json({ success: false }, { status: 400 });
  }
}
