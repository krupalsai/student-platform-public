import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Records a server-side error for the /api/cron/health-check job to pick
 * up, triage (Claude primary, Gemini fallback — see src/lib/ai-triage.ts),
 * and report on (Telegram + a GitHub issue with a suggested fix when
 * confident). This is IN ADDITION to console.error —
 * it never replaces it, and it never throws (a broken logger must not be
 * able to break the route it's logging for).
 *
 * Call this from a route's existing catch block:
 *   console.error("[api/profile]", err);
 *   await logSystemError(db, "api/profile", err);
 */
export async function logSystemError(
  db: SupabaseClient,
  route: string,
  err: unknown,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? null : null;
    await db.from("system_errors").insert({ route, message, stack, meta: meta ?? null });
  } catch {
    // best-effort only — never let logging itself break the caller
  }
}
