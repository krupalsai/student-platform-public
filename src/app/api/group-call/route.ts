import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { canReadGroupChat } from "@/lib/authz";
import { forbidden, badRequest, serverError, ok } from "@/lib/api-response";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const maxDuration = 30;

type SessionDescription = { type: "offer" | "answer"; sdp: string };
type Track = { location: "local" | "remote"; trackName?: string; sessionId?: string; mid?: string | null };
const CF_BASE = "https://rtc.live.cloudflare.com/apps";

function credentials() {
  const appId = process.env.CLOUDFLARE_CALLS_APP_ID?.trim();
  const secret = process.env.CLOUDFLARE_CALLS_APP_SECRET?.trim();
  if (!appId || !secret) throw new Error("Cloudflare Realtime credentials are not configured");
  return { appId, secret };
}

async function cloudflare(path: string, init: RequestInit = {}) {
  const { appId, secret } = credentials();
  const response = await fetch(`${CF_BASE}/${appId}${path}`, { ...init, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(init.headers ?? {}) }, cache: "no-store" });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { errorDescription: text }; }
  if (!response.ok) { console.error("[group-call] Cloudflare Realtime error", response.status, body); throw new Error(body?.errorDescription || body?.message || `Realtime API ${response.status}`); }
  return body;
}

function validDescription(value: unknown): value is SessionDescription {
  return !!value && typeof value === "object" && ((value as any).type === "offer" || (value as any).type === "answer") && typeof (value as any).sdp === "string" && (value as any).sdp.length > 0;
}
function validTrack(track: any): track is Track {
  if (!track || typeof track !== "object" || (track.location !== "local" && track.location !== "remote")) return false;
  if (track.location === "local") return typeof track.trackName === "string" && track.trackName.length > 0 && track.trackName.length < 256 && (track.mid == null || typeof track.mid === "string");
  return typeof track.sessionId === "string" && track.sessionId.length > 0 && track.sessionId.length < 256 && typeof track.trackName === "string" && track.trackName.length > 0 && track.trackName.length < 256;
}

async function authorize(batchId: unknown, req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return { user: null, response: forbidden() };
  if (typeof batchId !== "string" || !batchId) return { user: null, response: badRequest("Batch is required") };
  // Role-independent, enrolment-only check — matches
  // group-chat/[batchId]/messages/route.ts's resolveAccess(). The previous
  // `user.role !== "student" || (...)` gave ANY non-student an unconditional
  // pass regardless of which batchId was actually requested, letting a plain
  // `admin` (who per item #110 should have zero group-chat/console access)
  // join or moderate the voice/video call for ANY batch platform-wide.
  // super_admin/viewer still get in via canReadGroupChat's own role check
  // below; a student is still restricted to their own batch.
  const isOwnBatch = user.isProfileComplete === true && user.batchId === batchId;
  if (!canReadGroupChat(user.role, isOwnBatch)) return { user: null, response: forbidden() };
  return { user, response: null };
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return badRequest("Invalid request"); }
  const auth = await authorize(body?.batchId, req);
  if (auth.response) return auth.response;
  try {
    if (body?.action === "session") {
      if (!validDescription(body.sessionDescription) || body.sessionDescription.type !== "offer") return badRequest("A WebRTC offer is required");
      const result = await cloudflare("/sessions/new", { method: "POST", body: JSON.stringify({ sessionDescription: body.sessionDescription }) });
      if (!result?.sessionId || !validDescription(result.sessionDescription)) throw new Error("Realtime session response was incomplete");
      return ok({ sessionId: result.sessionId, sessionDescription: result.sessionDescription });
    }
    if (body?.action === "create-session") {
      // Pull-only sessions start empty. Cloudflare's official SFU flow creates
      // this session first, then asks /tracks/new for the remote-track offer.
      // Cloudflare's documented empty-session flow sends POST with no JSON
      // body. Sending "{}" can be rejected by the Realtime API validator as
      // an incomplete sessionDescription request.
      const result = await cloudflare("/sessions/new", { method: "POST" });
      if (!result?.sessionId) throw new Error("Realtime session response was incomplete");
      return ok({ sessionId: result.sessionId });
    }
    if (body?.action === "tracks") {
      if (typeof body.sessionId !== "string" || body.sessionId.length < 1 || body.sessionId.length > 256) return badRequest("Invalid session");
      if (!Array.isArray(body.tracks) || body.tracks.length < 1 || body.tracks.length > 64 || !body.tracks.every(validTrack)) return badRequest("Invalid media tracks");
      if (body.tracks.some((t: Track) => t.location === "local") && !validDescription(body.sessionDescription)) return badRequest("A WebRTC offer is required when publishing");
      if (body.tracks.some((t: Track) => t.location === "remote")) {
        for (const track of body.tracks as Track[]) if (track.location === "remote" && !track.trackName?.startsWith("sp-")) return badRequest("Invalid group-call track");
      }
      return ok(await cloudflare(`/sessions/${encodeURIComponent(body.sessionId)}/tracks/new`, { method: "POST", body: JSON.stringify({ tracks: body.tracks, ...(validDescription(body.sessionDescription) ? { sessionDescription: body.sessionDescription } : {}) }) }));
    }
    if (body?.action === "renegotiate") {
      if (typeof body.sessionId !== "string" || !validDescription(body.sessionDescription) || body.sessionDescription.type !== "answer") return badRequest("A WebRTC answer is required");
      return ok(await cloudflare(`/sessions/${encodeURIComponent(body.sessionId)}/renegotiate`, { method: "PUT", body: JSON.stringify({ sessionDescription: body.sessionDescription }) }) ?? { success: true });
    }
    return badRequest("Unknown group-call action");
  } catch (e) {
    console.error("[api/group-call]", e);
    return serverError("Group call service is not configured or is temporarily unavailable.");
  }
}
