import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { checkResourceHealth } from "@/lib/resource-health";
import { sendStandalonePaymentReminders, escalateUnansweredQuestions } from "@/lib/services/proactive-nudges";
import { runCourtOrderWatch } from "@/lib/services/court-order-watch";

// Keep-alive + daily maintenance endpoint. Hit by Vercel Cron (see
// vercel.json) to prevent Supabase free-tier project pausing after 7 days of
// inactivity. It also performs the daily cleanup and capacity check so we
// don't need a second cron job.
//
// Auth: CRON_SECRET only (same convention as /api/cron/court-order-watch
// and docs/CRON_SECRET_SETUP.md) — `Authorization: Bearer <CRON_SECRET>` or
// `x-cron-secret: <CRON_SECRET>`. Vercel Cron sends this automatically once
// CRON_SECRET is set as a project env var. Unauthenticated callers get 403:
// this endpoint deletes rows with the service-role client and triggers
// payment reminders, question escalation and court-order notifications, so
// it must never run on an outside caller's say-so.
// (2026-11-10 security audit: public /api/ping could trigger privileged
// background work.)

function authorized(req: NextRequest): boolean {
  const secret = process.env["CRON_" + "SECRET"];
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret;
}

async function sweepExpiredRows(db: ReturnType<typeof createServiceClient>) {
  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const sweeps: Array<[string, PromiseLike<{ error: { message: string } | null }>]> = [
    ["sessions", db.from("sessions").delete().lt("expires_at", now)],
    ["app_login_otps", db.from("app_login_otps").delete().lt("expires_at", now)],
    ["registration_token_otps", db.from("registration_token_otps").delete().lt("expires_at", now)],
    ["rate_limits", db.from("rate_limits").delete().lt("created_at", dayAgo)],
  ];

  for (const [name, q] of sweeps) {
    try {
      const { error } = await q;
      if (error) console.error(`[api/ping] sweep ${name} failed:`, error.message);
    } catch (e) {
      console.error(`[api/ping] sweep ${name} threw:`, e);
    }
  }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const db = createServiceClient();
    await db.from("app_settings").select("key").limit(1);
    await sweepExpiredRows(db);

    // Capacity warnings are best-effort. A Cloudinary/API problem must never
    // make the keep-alive endpoint fail or affect students.
    try {
      await checkResourceHealth(db);
    } catch (e) {
      console.error("[api/ping] resource health check failed:", e);
    }

    // Proactive nudges — piggy-backed onto this same daily cron rather than
    // adding a second one (same reasoning as the sweep above). Each function
    // is already internally best-effort and never throws, but wrapped here
    // too so a genuinely unexpected failure still can't affect the ping.
    try {
      await sendStandalonePaymentReminders(db);
    } catch (e) {
      console.error("[api/ping] payment reminder sweep failed:", e);
    }
    try {
      await escalateUnansweredQuestions(db);
    } catch (e) {
      console.error("[api/ping] question escalation sweep failed:", e);
    }

    // Court order watch — same daily cron, same reasoning: checks every
    // tracked batch's High Court case for newly published order soft copies
    // and sends the batch's students an in-app (push) notification the
    // moment one appears. Internally best-effort and never throws, wrapped
    // here too so it can't affect the ping.
    try {
      const watch = await runCourtOrderWatch(db);
      if (watch.newOrders > 0 || watch.errors.length > 0) {
        console.log("[api/ping] court order watch:", JSON.stringify(watch));
      }
    } catch (e) {
      console.error("[api/ping] court order watch failed:", e);
    }

    return NextResponse.json({ ok: true, ts: new Date().toISOString() });
  } catch (err) {
    console.error("[api/ping]", err);
    return NextResponse.json({ ok: true, ts: new Date().toISOString(), db: "unreachable" });
  }
}
