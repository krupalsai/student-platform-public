import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runCourtOrderWatch } from "@/lib/services/court-order-watch";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Manual trigger for the court order watch (the daily run piggy-backs on
 * /api/ping's cron — see vercel.json). Same CRON_SECRET auth as the other
 * cron routes. Lets the admin force a check right after a hearing instead
 * of waiting for the next daily run.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env["CRON_" + "SECRET"];
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = createServiceClient();
  const result = await runCourtOrderWatch(db);
  return NextResponse.json({ ok: true, ...result, ts: new Date().toISOString() });
}
