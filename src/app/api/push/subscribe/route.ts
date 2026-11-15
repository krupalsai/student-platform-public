import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { savePushSubscription } from "@/lib/push/subscriptions";
import { ok, unauthorized, zodError, dbError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const Schema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

/**
 * Requires an authenticated session — a subscription is only ever saved
 * against the profile that proved ownership of the device by being logged
 * in on it. Accepting a bare phone number here instead would let anyone
 * register a subscription for someone else's number and intercept their
 * next login code; see requestAppLoginOtp for the delivery side.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return unauthorized();

  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return zodError(body.error);

  try {
    await savePushSubscription(
      createServiceClient(),
      user.profileId,
      { endpoint: body.data.endpoint, p256dh: body.data.keys.p256dh, auth: body.data.keys.auth },
      req.headers.get("user-agent")
    );
    return ok({ saved: true });
  } catch (e) {
    return dbError("api/push/subscribe", e);
  }
}
