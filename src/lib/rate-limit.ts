/**
 * Simple sliding-window rate limiter backed by Supabase.
 *
 * Plain-English: this stops someone from spamming a button (like "Pay Now")
 * over and over in a short time. If they try too many times too fast, we
 * politely block them for a bit instead of letting it overload the system.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

/**
 * ── Failed-attempt limiter, for authentication only ─────────────────────────
 *
 * checkRateLimit() above deliberately FAILS OPEN: a rate-limit table hiccup
 * must never block a legitimate payment. That trade-off is exactly backwards
 * for a login check, where failing open means an unlimited guessing budget.
 * These three functions are the auth counterpart and FAIL CLOSED.
 *
 * They are split into count/record/clear rather than reusing the single
 * check-and-insert helper because only a FAILED attempt should consume the
 * budget — counting successes too would lock out a person who simply logs in
 * from several devices in one window.
 *
 * Why this exists: a login OTP here is 6 digits (1,000,000 combinations) and
 * lives for 5 minutes. Without an attempt cap, an attacker who knows an
 * admin's phone number can request a code and then guess against it as fast
 * as the platform will answer — and serverless scales the guessing for them.
 * A few hundred thousand guesses inside one 5-minute window is a meaningful
 * chance per window, repeatable indefinitely. The cap is what makes the OTP
 * actually worth 6 digits instead of ~0 bits. Never remove it, and never
 * "fix" a failing lookup here by falling through to allowed.
 */
export async function countRecentAttempts(
  db: SupabaseClient,
  bucketKey: string,
  windowSec: number
): Promise<number | null> {
  const windowStart = new Date(Date.now() - windowSec * 1000).toISOString();
  const { count, error } = await db
    .from("rate_limits")
    .select("id", { count: "exact", head: true })
    .eq("bucket_key", bucketKey)
    .gte("created_at", windowStart);
  // null = "could not determine" — callers must treat this as over-limit.
  if (error) {
    console.error("[rate-limit] auth attempt count failed (failing CLOSED):", error.message);
    return null;
  }
  return count ?? 0;
}

/** Records one failed authentication attempt against a bucket. */
export async function recordFailedAttempt(db: SupabaseClient, bucketKey: string): Promise<void> {
  const { error } = await db.from("rate_limits").insert({ bucket_key: bucketKey });
  if (error) console.error("[rate-limit] failed-attempt record failed:", error.message);
}

/**
 * Records one completed rate-limited action (e.g. an OTP that was actually
 * issued) against a bucket, so isLockedOut() can cap how often it happens.
 * Same table/row shape as recordFailedAttempt — only the meaning differs:
 * this counts successes, not failures. Used by the OTP request route, where
 * counting failures would be useless (a request that never fails is exactly
 * the spam case: codes sent to a victim's phone over and over).
 */
export async function recordAttempt(db: SupabaseClient, bucketKey: string): Promise<void> {
  const { error } = await db.from("rate_limits").insert({ bucket_key: bucketKey });
  if (error) console.error("[rate-limit] attempt record failed:", error.message);
}

/** Clears a bucket after a successful authentication, so the cap never punishes a real user. */
export async function clearFailedAttempts(db: SupabaseClient, bucketKey: string): Promise<void> {
  const { error } = await db.from("rate_limits").delete().eq("bucket_key", bucketKey);
  if (error) console.error("[rate-limit] failed-attempt clear failed:", error.message);
}

/**
 * Convenience wrapper: is this bucket already over its failed-attempt budget?
 * Returns true when over-limit OR when the check itself could not run.
 */
export async function isLockedOut(
  db: SupabaseClient,
  bucketKey: string,
  maxAttempts: number,
  windowSec: number
): Promise<boolean> {
  const used = await countRecentAttempts(db, bucketKey, windowSec);
  return used === null || used >= maxAttempts;
}

export async function checkRateLimit(
  db: SupabaseClient,
  bucketKey: string,
  maxAttempts: number,
  windowSec: number
): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - windowSec * 1000).toISOString();

  const { count, error } = await db
    .from("rate_limits")
    .select("id", { count: "exact", head: true })
    .eq("bucket_key", bucketKey)
    .gte("created_at", windowStart);

  if (error) {
    // Fail open — never block a legitimate payment because the rate-limit
    // table had a hiccup. Security should never break the core business flow.
    console.error("Rate limit check failed (failing open):", error.message);
    return { allowed: true, remaining: maxAttempts };
  }

  const used = count ?? 0;
  if (used >= maxAttempts) {
    return { allowed: false, remaining: 0, retryAfterSeconds: windowSec };
  }

  await db.from("rate_limits").insert({ bucket_key: bucketKey });

  // Cleanup of expired rows. Awaited, not fire-and-forget: on Vercel an
  // unawaited query is killed when the lambda freezes after the response, so
  // this never ran and the table only ever grew. It is a single indexed
  // DELETE on rows already outside the window.
  const { error: cleanupErr } = await db
    .from("rate_limits")
    .delete()
    .lt("created_at", new Date(Date.now() - windowSec * 1000 * 4).toISOString());
  if (cleanupErr) console.error("[lib/rate-limit] cleanup failed:", cleanupErr.message);

  return { allowed: true, remaining: maxAttempts - used - 1 };
}
