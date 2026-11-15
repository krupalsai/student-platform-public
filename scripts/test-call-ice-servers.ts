/**
 * Pins the ICE configuration every in-app call depends on.
 *
 * Live report: "the in call experience was total bad" — failures to connect,
 * one-way audio, choppy/robotic audio and mid-call drops, all at once. Every
 * RTCPeerConnection in the app was built STUN-only:
 *
 *     new RTCPeerConnection({ iceServers: [{ urls: "stun:..." }] })
 *
 * STUN only reveals a peer's public address; it cannot carry media. Behind the
 * symmetric/carrier-grade NAT normal on Indian mobile networks there is often
 * no direct path, and with no relay a call has nothing to fall back on — which
 * is exactly how all four symptoms show up together rather than separately.
 *
 * A hardcoded STUN-only list is easy to reintroduce: it looks like a harmless
 * default and it "works" on a laptop on office Wi-Fi, where a direct path
 * exists. These assertions are what catch that.
 *
 *   node --experimental-strip-types scripts/test-call-ice-servers.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

const route = readFileSync("src/app/api/calls/ice-servers/route.ts", "utf8");
const hook = readFileSync("src/lib/hooks/useVoiceCall.ts", "utf8");
const page = readFileSync("src/app/discussion/call/page.tsx", "utf8");

let passed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
}

// ── No peer connection may hardcode its ICE servers ───────────────────────
for (const [label, src] of [["useVoiceCall", hook], ["group call page", page]] as const) {
  const constructions = src.match(/new RTCPeerConnection\([\s\S]{0,200}?\)/g) ?? [];
  ok(`${label} still constructs a peer connection`, constructions.length > 0);
  for (const c of constructions) {
    ok(
      `${label} takes its ICE servers from iceServersRef, not a literal`,
      c.includes("iceServersRef.current"),
      `found: ${c.replace(/\s+/g, " ").slice(0, 120)} — a hardcoded list means no TURN, ` +
      "so the call has no relay to fall back on behind NAT",
    );
  }
}

// ── The credentials must actually be fetched before the call starts ───────
for (const [label, src] of [["useVoiceCall", hook], ["group call page", page]] as const) {
  ok(`${label} fetches ICE servers from the endpoint`, src.includes("/api/calls/ice-servers"));
  ok(
    `${label} loads them alongside the microphone, not after the connection`,
    /Promise\.all\(\[[\s\S]{0,200}?loadIceServers\(\)/.test(src),
    "fetching after the peer connection is built is the same as not fetching at all",
  );
}

// ── The API token is a server secret ──────────────────────────────────────
ok(
  "the TURN API token is read server-side only",
  route.includes("process.env.CLOUDFLARE_TURN_API_TOKEN") &&
    !route.includes("NEXT_PUBLIC_CLOUDFLARE_TURN"),
  "a NEXT_PUBLIC_ token ships to every browser and is a long-term credential",
);
ok("the endpoint is session-gated", /requireSession/.test(route));

// ── It must fail SOFT ─────────────────────────────────────────────────────
// A call that might connect beats a call that cannot start. If this endpoint
// ever starts throwing on a missing key or a Cloudflare hiccup, it turns an
// improvement into a new outage.
ok(
  "an unconfigured TURN key falls back to STUN rather than erroring",
  /if \(!TURN_KEY_ID \|\| !TURN_API_TOKEN\)[\s\S]{0,160}?STUN_ONLY/.test(route),
);
ok(
  "a Cloudflare error falls back to STUN rather than erroring",
  /if \(!res\.ok\)[\s\S]{0,300}?STUN_ONLY/.test(route),
);
ok(
  "a thrown request falls back to STUN rather than erroring",
  /catch \(e\)[\s\S]{0,200}?STUN_ONLY/.test(route),
);
ok(
  "the endpoint never returns a non-2xx for a missing/broken TURN key",
  !/status:\s*5\d\d/.test(route),
);

// ── A failed fetch on the client must not break the call either ───────────
for (const [label, src] of [["useVoiceCall", hook], ["group call page", page]] as const) {
  ok(
    `${label} keeps its STUN-only default when the fetch fails`,
    /const loadIceServers = useCallback\([\s\S]{0,900}?catch \{/.test(src),
  );
}

console.log(`test-call-ice-servers: all ${passed} assertions passed`);
