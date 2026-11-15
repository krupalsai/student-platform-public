/**
 * WhatsApp Calling — signalling control plane.
 *
 * Wraps the three actions Meta exposes for an inbound call. Verified against
 * Meta's Calling API documentation (Aug 2026):
 *
 *   POST <PHONE_NUMBER_ID>/calls
 *   { messaging_product: "whatsapp", call_id, action, session? }
 *
 *   action "pre_accept" — answer the SDP early so media is flowing before the
 *                         call formally connects. Meta recommends it; skipping
 *                         it clips the first word of the greeting.
 *   action "accept"     — connect the call. Media flows immediately.
 *   action "reject"     — decline. No session needed.
 *
 * We have roughly 30–60 seconds from the connect webhook to respond, which is
 * generous — but the media server has to produce an SDP answer inside it, so
 * every call here is bounded by an explicit timeout rather than left to hang.
 *
 * This module does NOT touch media. It only speaks the Graph API. All WebRTC
 * lives in media-server/, because a serverless function cannot hold an audio
 * stream open.
 */

const GRAPH_VERSION = "v20.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? "";

/** Meta gives 30–60s; stay well inside it so a hung request can't eat the window. */
const REQUEST_TIMEOUT_MS = 10_000;

export type CallAction = "pre_accept" | "accept" | "reject" | "terminate";

export interface CallActionResult {
  ok: boolean;
  error?: string;
}

async function callAction(
  callId: string,
  action: CallAction,
  sdpAnswer?: string,
): Promise<CallActionResult> {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    return { ok: false, error: "WhatsApp credentials are not configured." };
  }

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    call_id: callId,
    action,
  };
  // Only pre_accept and accept carry an SDP answer; reject/terminate must not.
  if (sdpAnswer && (action === "pre_accept" || action === "accept")) {
    body.session = { sdp_type: "answer", sdp: sdpAnswer };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/calls`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message ?? `HTTP ${res.status}`;
      // Logged without the token or the SDP — SDP carries ICE credentials.
      console.error(`[call-control] ${action} failed for ${callId}: ${msg}`);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? "timeout" : (e as Error).message;
    console.error(`[call-control] ${action} error for ${callId}: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Answers the SDP early so audio is flowing before connect. */
export const preAcceptCall = (callId: string, sdpAnswer: string) =>
  callAction(callId, "pre_accept", sdpAnswer);

/** Connects the call. Media flows immediately after Meta returns 200. */
export const acceptCall = (callId: string, sdpAnswer: string) =>
  callAction(callId, "accept", sdpAnswer);

/** Declines. Used when the media server is unreachable or the caller is barred. */
export const rejectCall = (callId: string) => callAction(callId, "reject");

/**
 * Ends an active call from our side.
 * Meta requires this explicitly, "even if there is an RTCP BYE packet in the
 * media path" — so hanging up the peer connection alone leaks the call.
 */
export const terminateCall = (callId: string) => callAction(callId, "terminate");
