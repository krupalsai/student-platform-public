import type { SupabaseClient } from "@supabase/supabase-js";
import { isStaff } from "@/lib/authz";

/**
 * Closed-batch gate — stops students whose batch is finished from using the
 * chat bot, on WhatsApp and Telegram alike.
 *
 * Once a batch is closed the student has been through the process, but they
 * keep messaging the bot, which costs a Groq call per message and buries real
 * students in the admin's queue. This shuts that off without touching the Mini
 * App: their dashboard and Route Map stay open, because someone in a closed
 * batch may still be collecting certificates.
 *
 * They are told once, then ignored — a first message that goes nowhere reads
 * as "broken" and produces more messages, not fewer.
 *
 * Deliberately NOT applied to:
 *   - admins (the WhatsApp router checks admin identity before reaching here)
 *   - students with no batch yet (registration in progress)
 *   - any batch that is not closed/archived
 */

export type GateDecision = "allow" | "notify" | "silence";

const CLOSED_STATUSES = ["closed", "archived"];

/** Admin toggle. Defaults ON — an unreadable setting must not silently
 *  re-open the bot to every old student. Only an explicit "false" disables it. */
export async function isClosedBatchBlockEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "block_closed_batch_students")
    .maybeSingle();
  return data?.value !== "false";
}

export async function setClosedBatchBlockEnabled(db: SupabaseClient, enabled: boolean): Promise<void> {
  await db.from("app_settings").upsert(
    { key: "block_closed_batch_students", value: String(enabled) },
    { onConflict: "key" },
  );
}

/**
 * Decides what to do with an incoming message from `profileId`.
 *
 * "notify" is returned at most once per channel — the marker is a
 * student_events row, so no new table or column is needed and the block shows
 * up on the student's existing timeline.
 */
export async function closedBatchGate(
  db: SupabaseClient,
  profileId: string | null | undefined,
  channel: "whatsapp" | "telegram",
): Promise<GateDecision> {
  if (!profileId) return "allow";

  try {
    if (!(await isClosedBatchBlockEnabled(db))) return "allow";

    const { data: profile } = await db
      .from("profiles")
      .select("role, batch_id")
      .eq("id", profileId)
      .maybeSingle();

    if (!profile) return "allow";
    // Staff are unaffected by the closed-batch notice. Allow-list rather than
    // "not a student" — the deny-list form exempts every role added later by
    // default, the same class of bug fixed in authz.ts.
    if (isStaff(profile.role)) return "allow";
    if (!profile.batch_id) return "allow";            // still registering

    const { data: batch } = await db
      .from("batches")
      .select("status")
      .eq("id", profile.batch_id)
      .maybeSingle();

    if (!batch || !CLOSED_STATUSES.includes(String(batch.status))) return "allow";

    const eventType = `closed_batch.notified_${channel}`;
    const { count } = await db
      .from("student_events")
      .select("id", { count: "exact", head: true })
      .eq("student_id", profileId)
      .eq("event_type", eventType);

    if ((count ?? 0) > 0) return "silence";

    await db.from("student_events").insert({
      student_id: profileId,
      batch_id: profile.batch_id,
      event_type: eventType,
    });
    return "notify";
  } catch (e) {
    // A gate failure must never swallow a live student's message.
    console.error("[closed-batch-gate]", e);
    return "allow";
  }
}

/**
 * Which batches "old students" actually means right now, with how many people
 * are in each. "Closed-batch students" is accurate but tells an admin nothing
 * about who they are switching off — this names them.
 */
export async function closedBatchSummary(
  db: SupabaseClient,
): Promise<{ label: string; students: number }> {
  try {
    const { data: batches } = await db
      .from("batches")
      .select("id, name")
      .in("status", CLOSED_STATUSES)
      .order("name", { ascending: true });

    const rows = (batches ?? []) as { id: string; name: string }[];
    // Archived drafts have no students and aren't batches anyone went through,
    // so listing them would just be noise. Only name batches with people in.
    const named: string[] = [];
    let total = 0;

    for (const b of rows) {
      // is_profile_complete=true — this total is shown to old students
      // ("N students went through these batches"), abandoned registration
      // attempts shouldn't inflate it.
      const { count } = await db
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("batch_id", b.id)
        .eq("role", "student")
        .eq("is_profile_complete", true);
      if ((count ?? 0) > 0) { named.push(b.name); total += count ?? 0; }
    }

    if (!named.length) return { label: "no finished batches yet", students: 0 };
    return { label: named.join(", "), students: total };
  } catch (e) {
    console.error("[closed-batch-gate] summary failed:", e);
    return { label: "finished batches", students: 0 };
  }
}

/** The one message an old student gets, before the bot goes quiet for them. */
export function closedBatchNotice(): string {
  return (
    "Your batch has been closed, so this bot no longer handles requests for it.\n\n" +
    "Your dashboard and Route Map still work — open the app any time to check your " +
    "steps and documents.\n\n" +
    "If you need help with something, please contact the admin directly."
  );
}
