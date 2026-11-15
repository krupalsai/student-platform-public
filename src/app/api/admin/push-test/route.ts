import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { isPushConfigured, sendPushMessage } from "@/lib/push/client";
import {
  deletePushSubscriptionByEndpoint,
  getPushSubscriptionsForStudent,
  markPushSubscriptionFailed,
  touchPushSubscription,
} from "@/lib/push/subscriptions";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/push-test — the safe VAPID probe.
 *
 * Sends ONE test push ONLY to the requesting admin's own subscriptions
 * (user.profileId). It can never message a student: there is no recipient
 * parameter, no batch, no broadcast. An admin runs it from their own
 * phone after enabling notifications in the Student App.
 *
 * The response names the real outcome per subscription:
 * - ok:true — the push service accepted it (VAPID key pair works).
 * - reason "not_configured" — VAPID keys missing/malformed on the server.
 * - reason "unauthorized" (401/403) — the VAPID private key does not match
 *   the public key; rotate/paste the correct pair in Vercel env vars.
 * - reason "expired" (404/410) — that device subscription is dead.
 * - reason "push_service_error" / "network_error" — push service / network.
 *
 * No inbox row is written and nothing else is notified.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireAdmin(req);
  if (error) return forbidden();
  try {
    const db = createServiceClient();
    const configured = isPushConfigured();
    const subscriptions = await getPushSubscriptionsForStudent(db, user!.profileId);

    if (!subscriptions.length) {
      return ok({
        configured,
        subscriptions: 0,
        delivered: 0,
        results: [],
        note: "No push subscription on this admin account — open the Student App on this device, enable notifications, then retry.",
      });
    }

    const results: Array<{ index: number; ok: boolean; expired: boolean; reason?: string; statusCode?: number }> = [];
    let delivered = 0;
    for (let i = 0; i < subscriptions.length; i++) {
      const sub = subscriptions[i]!;
      const result = await sendPushMessage(sub, {
        title: "Student Platform test push",
        body: "This is a test — push is working on this device.",
        tag: "student-platform-push-test",
        url: "/dashboard",
      });
      if (result.expired) await deletePushSubscriptionByEndpoint(db, sub.endpoint);
      else if (!result.ok) await markPushSubscriptionFailed(db, sub.id);
      else await touchPushSubscription(db, sub.id);
      if (result.ok) delivered++;
      results.push({ index: i, ok: result.ok, expired: result.expired, reason: result.reason, statusCode: result.statusCode });
    }

    return ok({ configured, subscriptions: subscriptions.length, delivered, results });
  } catch (e) {
    console.error("[api/admin/push-test]", e);
    return serverError();
  }
}
