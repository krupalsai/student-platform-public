import { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/services/students";

/**
 * Per-college FIFO waiting queue, backed by the existing `batch_waiting_queue`
 * table (created directly against the live database before this code existed —
 * see the migration granting service_role access to it). Its `processed_at`
 * column is reused as-is for the same lifecycle a `notified_at` column would
 * represent: NULL = still waiting, set = link has been sent. No new column
 * introduced — there's no business requirement distinct from "has this
 * student been sent their registration link yet."
 */

export interface WaitlistJoinResult {
  alreadyWaiting: boolean;
  position: number; // 1-based FIFO position among not-yet-processed entries
}

/**
 * Adds a student to the per-college waiting list. Idempotent: if they're
 * already waiting (and not yet processed), this just returns their current
 * position instead of creating a duplicate row — relies on
 * batch_waiting_queue's existing partial unique index on (phone, college)
 * WHERE processed_at IS NULL, so a race condition can't create a duplicate
 * even under concurrent requests.
 */
export async function joinWaitlist(
  db: SupabaseClient,
  college: string,
  phone: string,
): Promise<WaitlistJoinResult> {
  const normalized = normalizePhone(phone);

  let row = (
    await db
      .from("batch_waiting_queue")
      .select("id, created_at")
      .eq("college", college)
      .eq("phone", normalized)
      .is("processed_at", null)
      .maybeSingle()
  ).data as { id: string; created_at: string } | null;

  let alreadyWaiting = !!row;

  if (!row) {
    const { data, error } = await db
      .from("batch_waiting_queue")
      .insert({ college, phone: normalized })
      .select("id, created_at")
      .single();
    if (error) {
      if (error.code === "23505") {
        // Lost a race with a concurrent request for the same student —
        // they're already waiting now, just re-fetch that row.
        const { data: winner } = await db
          .from("batch_waiting_queue")
          .select("id, created_at")
          .eq("college", college)
          .eq("phone", normalized)
          .is("processed_at", null)
          .single();
        row = winner!;
        alreadyWaiting = true;
      } else {
        throw error;
      }
    } else {
      row = data;
    }
  }

  const { count } = await db
    .from("batch_waiting_queue")
    .select("id", { count: "exact", head: true })
    .eq("college", college)
    .is("processed_at", null)
    .lte("created_at", row!.created_at);

  return { alreadyWaiting, position: count ?? 1 };
}

/** Count of students currently waiting for a college (not yet processed). */
export async function getWaitlistCount(db: SupabaseClient, college: string): Promise<number> {
  const { count } = await db
    .from("batch_waiting_queue")
    .select("id", { count: "exact", head: true })
    .eq("college", college)
    .is("processed_at", null);
  return count ?? 0;
}

/** FIFO list of students waiting for a college, oldest first. */
export async function listWaiting(
  db: SupabaseClient,
  college: string,
): Promise<{ id: string; phone: string }[]> {
  const { data } = await db
    .from("batch_waiting_queue")
    .select("id, phone")
    .eq("college", college)
    .is("processed_at", null)
    .order("created_at", { ascending: true });
  return data ?? [];
}

/**
 * Marks waitlist entries as processed. Call this only after registration
 * links have actually been sent — not before — so a delivery failure
 * doesn't silently drop someone from the queue.
 */
export async function markProcessed(db: SupabaseClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await db
    .from("batch_waiting_queue")
    .update({ processed_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}
