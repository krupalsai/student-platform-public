/**
 * /api/cron/hall-live-alert  (GET)
 *
 * Fires the "hall is live" WhatsApp alerts — see
 * src/lib/services/hall-live-alert.ts for the full design. Called every
 * ~10 minutes during court hours by .github/workflows/hall-live-alert.yml
 * (GitHub Actions cron, not Vercel Cron, so it isn't limited by the Vercel
 * plan's cron-frequency restrictions — same reason the health-check uses
 * Actions).
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` / `x-cron-secret: <CRON_SECRET>`,
 * or a normal admin session for manual triggering.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { checkAndAlertHallLive } from "@/lib/services/hall-live-alert";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function authorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  if (cronSecret && (authHeader === `Bearer ${cronSecret}` || req.headers.get("x-cron-secret") === cronSecret)) {
    return true;
  }
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    // Manual trigger path — an admin can run it from the browser to test.
    const { error: adminError } = await requireAdmin(req);
    if (adminError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const db = createServiceClient();
    const summary = await checkAndAlertHallLive(db);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[api/cron/hall-live-alert]", e);
    return NextResponse.json({ ok: false, error: "alert check failed" }, { status: 500 });
  }
}
