import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSystemError } from "@/lib/system-errors";
import { ok, tooManyRequests } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * The app reporting its own crashes and reload loops (item #240). Until now a
 * crash on a student's phone left no trace anywhere, so "the app crashes
 * every second" could only be guessed at.
 *
 * Public on purpose (a crashed app may have no valid session), so it is
 * strictly bounded: per-IP rate limit, every field length-capped, nothing
 * trusted, nothing sent back. A signed-in caller is tagged with their id.
 */
const Schema = z.object({
  kind: z.enum(["error", "rejection", "boundary", "reload_loop", "stuck_cover"]),
  message: z.string().max(400),
  stack: z.string().max(1500).optional(),
  path: z.string().max(200).optional(),
  trail: z.array(z.string().max(120)).max(25).optional(),
  standalone: z.boolean().optional(),
  role: z.string().max(20).optional(),
  ua: z.string().max(220).optional(),
});

export async function POST(req: NextRequest) {
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return ok({ received: false });
  try {
    const db = createServiceClient();
    const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
    const limit = await checkRateLimit(db, `client-error:${ip}`, 30, 600);
    if (!limit.allowed) return tooManyRequests("Too many reports.");
    const user = await getSession(req).catch(() => null);
    const d = body.data;
    await logSystemError(db, `client/${d.kind}`, new Error(d.message), {
      stack: d.stack, path: d.path, trail: d.trail, standalone: d.standalone,
      role: d.role, ua: d.ua, student_id: user?.profileId ?? null,
    });
  } catch { /* never fail the reporter */ }
  return ok({ received: true });
}
