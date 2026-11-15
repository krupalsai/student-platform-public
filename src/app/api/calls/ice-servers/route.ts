import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";

/**
 * GET /api/calls/ice-servers
 *
 * Short-lived TURN credentials for the in-app voice call.
 *
 * Every peer connection in the app was configured STUN-only:
 *
 *     iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
 *
 * STUN only tells a peer its public address; it cannot carry media. When both
 * ends sit behind symmetric NAT or carrier-grade NAT — the normal case on
 * Indian mobile networks — there is no direct path and the call has nothing to
 * fall back to. That single gap produces every symptom reported at once:
 * connection failures, one-way audio when only one side traverses, choppy
 * audio over a marginal path, and mid-call drops when the path changes (a
 * handover between towers, or Wi-Fi to mobile data).
 *
 * TURN relays the media when a direct path cannot be found. Cloudflare's TURN
 * is the natural pairing here since the SFU is already Cloudflare.
 *
 * The API token is a long-term secret and stays on the server: the browser
 * receives only the generated username/credential, which expire.
 *
 * Fails SOFT. If TURN is not configured, or Cloudflare errors, this returns
 * the STUN-only list the app uses today rather than an error. A call that
 * might connect is strictly better than one that cannot start — this endpoint
 * can only ever improve connectivity, never block it.
 */

const TURN_KEY_ID = (process.env.CLOUDFLARE_TURN_KEY_ID ?? "").trim();
const TURN_API_TOKEN = (process.env.CLOUDFLARE_TURN_API_TOKEN ?? "").trim();

/** Comfortably longer than any call, short enough that a leaked credential dies. */
const TTL_SECONDS = 2 * 60 * 60;

/** What the app used before TURN existed, and the floor it falls back to. */
const STUN_ONLY = [{ urls: "stun:stun.cloudflare.com:3478" }];

export async function GET(req: NextRequest) {
  // Session-gated: these credentials cost relay bandwidth, so they are not
  // handed to anonymous callers.
  const { error } = await requireSession(req);
  if (error) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!TURN_KEY_ID || !TURN_API_TOKEN) {
    return NextResponse.json({ iceServers: STUN_ONLY, turn: false });
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TURN_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
        cache: "no-store",
      },
    );

    if (!res.ok) {
      console.error(`[ice-servers] Cloudflare TURN ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return NextResponse.json({ iceServers: STUN_ONLY, turn: false });
    }

    const json = await res.json();
    const iceServers = json?.iceServers;
    if (!Array.isArray(iceServers) || iceServers.length === 0) {
      console.error("[ice-servers] Cloudflare TURN returned no iceServers");
      return NextResponse.json({ iceServers: STUN_ONLY, turn: false });
    }

    return NextResponse.json({ iceServers, turn: true });
  } catch (e) {
    console.error("[ice-servers] TURN request failed:", e);
    return NextResponse.json({ iceServers: STUN_ONLY, turn: false });
  }
}
