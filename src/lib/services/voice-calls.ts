import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * In-app voice calls between a student and an admin.
 *
 * This module owns the RULES (who may call, when a call is stale, what the
 * browser is allowed to connect through). The WebRTC itself lives in the
 * client hook; the audio never reaches the server at all — see the header of
 * migration 0075 for why that is true here but not for WhatsApp calls.
 */

export type CallStatus = "ringing" | "accepted" | "declined" | "ended" | "missed";

/**
 * How long a call may ring before it counts as missed.
 *
 * There is no cron behind this. Any reader of a stale `ringing` row settles it
 * (see `settleStaleCalls`), so the state converges whether or not either party's
 * browser is still open — a student who closes the tab mid-ring must not leave a
 * call ringing in the admin console forever.
 */
export const RING_TIMEOUT_SECS = 60;

/**
 * A call is offered to every admin at once and the first to accept claims it.
 * Once accepted, only that admin may signal on it.
 */
export function canAnswerCalls(role: string): boolean {
  // Voice calls are a super-admin responsibility. Regular admins must never
  // see or claim a student's ringing call.
  return role === "super_admin";
}

/**
 * Who may place a call: anyone who has actually finished registering into a
 * batch. Same bar as Batch Discussion (item #74) — registration, NOT payment.
 * A student who cannot pay yet is exactly the one most likely to need to ask
 * an admin why.
 *
 * A batch is REQUIRED, with no staff bypass, and that is not arbitrary: the
 * media itself is carried by the batch-scoped group-call SFU room, so a caller
 * without a batch has nowhere to connect even if the ring succeeded. Role is
 * deliberately not consulted — an admin who is also enrolled (item #103) can
 * call as the student they are, and an admin who is not enrolled answers calls
 * rather than placing them.
 */
export function canPlaceCall(
  _role: string,
  isProfileComplete: boolean,
  batchId: string | null,
): boolean {
  return isProfileComplete === true && !!batchId;
}

/** Terminal states — a call here is over and must not accept further signals. */
export function isCallOver(status: string): boolean {
  return status === "declined" || status === "ended" || status === "missed";
}

/**
 * Settle any call that has been ringing past the timeout, marking it missed.
 *
 * Called from the read paths (the student's poll and the admin's pending list)
 * rather than a scheduled job: this platform is on Vercel's Hobby cron
 * allowance and a whole cron for a 60-second timeout is not worth one of the
 * slots. Returns the ids it settled.
 */
export async function settleStaleCalls(db: SupabaseClient): Promise<string[]> {
  const cutoff = new Date(Date.now() - RING_TIMEOUT_SECS * 1000).toISOString();
  const { data, error } = await db
    .from("voice_calls")
    .update({ status: "missed", ended_at: new Date().toISOString(), ended_by: "timeout" })
    .eq("status", "ringing")
    .lt("created_at", cutoff)
    .select("id");
  if (error) {
    console.error("[voice-calls] settleStaleCalls failed:", error.message);
    return [];
  }
  return (data ?? []).map((r: { id: string }) => r.id);
}

/** Admin-facing one-liner for a finished call. */
export function formatDuration(secs: number | null): string {
  if (secs == null || secs < 0) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface CallRow {
  id: string;
  student_id: string;
  /** The SFU room both sides join. Null would mean no media path — see canPlaceCall. */
  batch_id: string | null;
  admin_id: string | null;
  status: CallStatus;
  created_at: string;
  answered_at: string | null;
}

export type CallSide = "student" | "admin";

/**
 * Load a call and work out which side the caller is on — or refuse.
 *
 * A call is offered to every admin at once, so an unclaimed call is readable by
 * any admin (that is how they see it ringing). The moment one accepts,
 * `admin_id` is set and every OTHER admin loses access: two admins signalling
 * onto one peer connection would tear the call down for the student.
 *
 * Shared by the poll and the signal route so the two can never drift into
 * disagreeing about who is allowed on a call.
 */
export async function loadParticipantCall(
  db: SupabaseClient,
  callId: string,
  profileId: string,
  role: string,
): Promise<{ call: CallRow | null; side: CallSide | null }> {
  const { data, error } = await db
    .from("voice_calls")
    .select("id, student_id, batch_id, admin_id, status, created_at, answered_at")
    .eq("id", callId)
    .maybeSingle();
  if (error || !data) return { call: null, side: null };

  const call = data as CallRow;
  if (call.student_id === profileId) return { call, side: "student" };
  if (canAnswerCalls(role) && (call.admin_id === null || call.admin_id === profileId)) {
    return { call, side: "admin" };
  }
  return { call: null, side: null };
}
