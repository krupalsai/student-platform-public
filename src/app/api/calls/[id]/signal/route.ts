import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, badRequest, notFound, conflict, serverError, dbError } from "@/lib/api-response";
import { loadParticipantCall, isCallOver } from "@/lib/services/voice-calls";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

const SIGNAL_KINDS = new Set(["sfu"]);
/**
 * An SDP offer with many codecs runs a few KB; an ICE candidate is tiny. 64 KB
 * is far above anything legitimate and well below anything worth storing.
 */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Post one WebRTC signal to the other side.
 *
 * This is the entire server role in a call: move an SDP offer, an SDP answer,
 * and some ICE candidates between two browsers. The audio itself never arrives
 * here — it goes peer to peer once these have been exchanged.
 */
export async function POST(req: NextRequest, ctx: RouteContext) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const { id } = await ctx.params;
  const db = createServiceClient();

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return badRequest("Malformed signal.");

    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!SIGNAL_KINDS.has(kind)) return badRequest("Unknown signal kind.");
    if (body.payload == null || typeof body.payload !== "object") return badRequest("Signal payload missing.");
    if (JSON.stringify(body.payload).length > MAX_PAYLOAD_BYTES) return badRequest("Signal payload too large.");

    const { call, side } = await loadParticipantCall(db, id, user!.profileId, user!.role);
    if (!call || !side) return notFound("Call");
    if (isCallOver(call.status)) return conflict("That call has ended.");

    const { error: err } = await db.from("voice_call_signals").insert({
      call_id: id,
      sender: side,
      kind,
      payload: body.payload,
    });
    if (err) return dbError("api/calls/[id]/signal POST", err);
    return ok({ sent: true });
  } catch (e) {
    console.error("[api/calls/[id]/signal POST]", e);
    return serverError();
  }
}
