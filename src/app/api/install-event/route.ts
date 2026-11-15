import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { ok, badRequest, tooManyRequests } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/install-event — records which path a student took on the
 * Install page: "installed" (accepted the install prompt), "browser"
 * (continued to registration in the browser), "chrome-escape" (opened the
 * page in Chrome from an in-app browser), or "ios-steps" (shown the iOS
 * Add to Home Screen path).
 *
 * There is no anonymous telemetry table, so this writes to system_errors
 * with reported=true — the row is queryable in the database but the
 * health-check only ever reads reported=false rows, so install choices
 * can never trip an alert or pollute triage. Best-effort: a logging
 * failure never fails the request.
 */
const Schema = z.object({
  path: z.enum(["installed", "browser", "chrome-escape", "ios-steps"]),
  ua: z.string().max(220).optional(),
});

export async function POST(req: NextRequest) {
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Invalid install event.");
  const db = createServiceClient();
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const limit = await checkRateLimit(db, `install-event:${ip}`, 30, 600);
  if (!limit.allowed) return tooManyRequests("Too many events.");
  try {
    await db.from("system_errors").insert({
      route: "pwa/install-path",
      message: `install path: ${body.data.path}`,
      stack: null,
      reported: true,
      meta: { ua: body.data.ua ?? null },
    });
  } catch {
    /* logging must never break the install flow */
  }
  return ok({ received: true });
}
