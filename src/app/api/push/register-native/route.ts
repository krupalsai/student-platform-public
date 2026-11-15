import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, unauthorized, zodError, dbError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const Schema = z.object({
  token: z.string().min(1),
  platform: z.enum(["android", "ios"]),
});

/**
 * Native-app counterpart to /api/push/subscribe (Web Push VAPID subscriptions).
 * A real FCM registration token, from the Capacitor shell only — same
 * session-required reasoning as the web route: only the profile that proved
 * ownership of the device by being logged in on it may register a token
 * against it. sendNativeCallPush (src/lib/push/native-fcm.ts) reads this
 * table to ring a student's device for an admin callback even while the app
 * is fully closed.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return unauthorized();

  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return zodError(body.error);

  try {
    const db = createServiceClient();
    // fcm_token is UNIQUE — upsert on it, not on (student_id, platform), so a
    // token that rotated onto a different student (a shared/reset device) is
    // correctly reassigned rather than left orphaned under the old owner.
    const { error: err } = await db
      .from("native_push_tokens")
      .upsert(
        {
          student_id: user.profileId,
          platform: body.data.platform,
          fcm_token: body.data.token,
          last_used_at: new Date().toISOString(),
        },
        { onConflict: "fcm_token" }
      );
    if (err) return dbError("api/push/register-native", err);
    return ok({ saved: true });
  } catch (e) {
    return dbError("api/push/register-native", e);
  }
}
