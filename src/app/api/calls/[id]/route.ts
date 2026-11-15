import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, badRequest, notFound, conflict, serverError, dbError } from "@/lib/api-response";
import { loadParticipantCall, isCallOver, settleStaleCalls } from "@/lib/services/voice-calls";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The poll both sides run while a call is up (~1s).
 *
 * Returns the call's state plus every signal from the OTHER side after the
 * caller's cursor. Signals are never deleted on read — a poll response lost to
 * a flaky mobile connection would otherwise drop an ICE candidate and leave the
 * call connecting forever. The client advances its cursor only on a response it
 * actually received.
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const { id } = await ctx.params;
  const db = createServiceClient();

  try {
    await settleStaleCalls(db);
    const { call, side } = await loadParticipantCall(db, id, user!.profileId, user!.role);
    if (!call || !side) return notFound("Call");

    const since = Number(req.nextUrl.searchParams.get("since") ?? 0) || 0;
    const { data: signals, error: err } = await db
      .from("voice_call_signals")
      .select("id, sender, kind, payload")
      .eq("call_id", id)
      .neq("sender", side)          // never replay our own signals back to us
      .gt("id", since)
      .order("id", { ascending: true })
      .limit(100);
    if (err) return dbError("api/calls/[id] GET", err);

    const rows = signals ?? [];
    return ok({
      call,
      side,
      signals: rows,
      cursor: rows.length ? rows[rows.length - 1].id : since,
    });
  } catch (e) {
    console.error("[api/calls/[id] GET]", e);
    return serverError();
  }
}

/**
 * Move the call's state: accept, decline, or end.
 *
 * Accept is the only one that races — every admin sees the same ringing call.
 * The UPDATE therefore requires the row to still be `ringing` and to still be
 * unclaimed, and the winner is decided by how many rows came back. That is bug
 * #18's guard, and item #111's lesson about reading it: PostgREST only fills
 * `count` when asked, so decide from the returned ROWS, never from `count`.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const { id } = await ctx.params;
  const db = createServiceClient();

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = typeof body.action === "string" ? body.action : "";
    if (!["accept", "decline", "end"].includes(action)) return badRequest("Unknown call action.");

    const { call, side } = await loadParticipantCall(db, id, user!.profileId, user!.role);
    if (!call || !side) return notFound("Call");

    if (action === "accept" || action === "decline") {
      if (call.status !== "ringing") return conflict("That call is no longer ringing.");

      // Student callbacks are pre-assigned to a super_admin. The student may
      // accept/decline only that callback; a student-originated call has no
      // admin_id and therefore cannot be accepted by its own caller.
      const isStudentCallback = side === "student" && !!call.admin_id;
      if (side !== "admin" && !isStudentCallback) return forbidden();

      const now = new Date().toISOString();
      const patch = action === "accept"
        ? { status: "accepted", ...(side === "admin" ? { admin_id: user!.profileId } : {}), answered_at: now }
        : { status: "declined", ended_at: now, ended_by: side };

      let query = db
        .from("voice_calls")
        .update(patch)
        .eq("id", id)
        .eq("status", "ringing");

      // Student-originated calls are unclaimed and race between super_admins.
      // A callback's admin_id is the ADMIN who placed it, never the student
      // accepting/declining it here — filtering on the student's own
      // profileId (as this used to) matches nothing and 409s every real
      // callback. loadParticipantCall already proved this caller owns this
      // specific row, so id + status is the whole guard for that side.
      if (side === "admin") query = query.is("admin_id", null);

      const { data, error: err } = await query
        .select("id, student_id, batch_id, admin_id, status, created_at, answered_at");
      if (err) return dbError("api/calls/[id] POST", err);
      if (!data || data.length === 0) {
        return conflict(isStudentCallback ? "That callback is no longer available." : "Another admin already picked up that call.");
      }
      return ok({ call: data[0] });
    }

    // end — either side may hang up, and hanging up twice is not an error.
    if (isCallOver(call.status)) return ok({ call });
    const endedAt = new Date();
    const startedAt = call.answered_at ? new Date(call.answered_at) : null;
    const duration = startedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null;

    const { data, error: err } = await db
      .from("voice_calls")
      .update({
        // A call hung up before it was ever answered is a miss, not a
        // completed call — the admin call log should not show it as answered.
        status: call.status === "ringing" ? "missed" : "ended",
        ended_at: endedAt.toISOString(),
        ended_by: side,
        duration_secs: duration,
      })
      .eq("id", id)
      .select("id, student_id, batch_id, admin_id, status, created_at, answered_at");
    if (err) return dbError("api/calls/[id] POST end", err);
    return ok({ call: data?.[0] ?? call });
  } catch (e) {
    console.error("[api/calls/[id] POST]", e);
    return serverError();
  }
}
