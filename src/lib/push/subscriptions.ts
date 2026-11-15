import { SupabaseClient } from "@supabase/supabase-js";
import { StoredPushSubscription } from "@/lib/push/client";

/**
 * A student can have several subscriptions (multiple devices/browsers).
 * Login OTP only needs one live one, so callers try them in order and stop
 * at the first success. A subscription that failed a previous send
 * (failed_at set) is tried last, not skipped outright — a single transient
 * failure shouldn't demote a device permanently. Two signals are truly
 * dead, and senders delete on both (see sendPushMessage's `dead` flag):
 * the push service's 404/410 (endpoint gone) and 401/403 (the VAPID key
 * pair no longer matches the one the subscription was created with, e.g.
 * after a key rotation — that subscription can never receive from this
 * server again). See markPushSubscriptionFailed / clearPushSubscriptionFailure.
 */
export async function getPushSubscriptionsForStudent(
  db: SupabaseClient,
  studentId: string
): Promise<(StoredPushSubscription & { id: string })[]> {
  const { data, error } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("student_id", studentId)
    .order("failed_at", { ascending: true, nullsFirst: true })
    .order("last_used_at", { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}

export async function savePushSubscription(
  db: SupabaseClient,
  studentId: string,
  sub: StoredPushSubscription,
  userAgent?: string | null
) {
  const { error } = await db
    .from("push_subscriptions")
    .upsert(
      {
        student_id: studentId,
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        user_agent: userAgent ?? null,
        failed_at: null,
      },
      { onConflict: "endpoint" }
    );
  if (error) throw error;
}

export async function deletePushSubscriptionByEndpoint(db: SupabaseClient, endpoint: string) {
  await db.from("push_subscriptions").delete().eq("endpoint", endpoint);
}

export async function touchPushSubscription(db: SupabaseClient, id: string) {
  await db
    .from("push_subscriptions")
    .update({ last_used_at: new Date().toISOString(), failed_at: null })
    .eq("id", id);
}

export async function markPushSubscriptionFailed(db: SupabaseClient, id: string, reason?: string) {
  await db.from("push_subscriptions").update({ failed_at: new Date().toISOString() }).eq("id", id);
  // Best effort: also record WHY it failed, so the next systemic break is
  // diagnosable from data alone. The 29 Oct 2026 break left 30 subscriptions
  // flagged failed_at with no reason stored, and nothing in the database
  // could tell a wrong VAPID key from dead endpoints. Guarded separately so
  // a missing column (migration 0101 not applied yet) can never break the
  // failed_at marking above.
  if (reason) {
    try {
      await db.from("push_subscriptions").update({ last_failure_reason: reason }).eq("id", id);
    } catch {
      // Column not present yet — failed_at above is the source of truth.
    }
  }
}
