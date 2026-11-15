/**
 * WhatsApp Calling — parser + missed-call decision logic.
 *
 * Calls the REAL parseCallEvents() from src/lib/whatsapp/calls.ts, with
 * payloads shaped from Meta's documented Calling API webhook:
 *   changes[].field === "calls"
 *   value.calls[] with id, from, to, event, timestamp, direction
 *   event "connect"   → incoming call carrying an SDP offer
 *   event "terminate" → status COMPLETED | REJECTED | FAILED
 *
 * Hermetic: parsing is pure, so nothing here touches Supabase or the Meta API.
 * The side-effecting half (handleCallEvent) is exercised through the decision
 * predicate it uses, rather than by mocking a database — the aim is to pin the
 * rules that decide whether a student gets a follow-up, which is where a bug
 * actually costs someone an answer.
 *
 * Run with: npx tsx scripts/test-whatsapp-calls.ts
 */
import assert from "node:assert/strict";

// Well-formed dummies, set before the import below. calls.ts pulls in the
// admin module, which constructs the Supabase client at module load and throws
// without these. Nothing here makes a network call — parsing is pure.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dummy.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";

// require(), not import: the env vars above must be set BEFORE calls.ts loads,
// and a static import would be hoisted above them. Top-level await isn't
// available under tsx's CJS output, so this is the one ordering that works.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const callsModule = require("../src/lib/whatsapp/calls") as typeof import("../src/lib/whatsapp/calls");
const { parseCallEvents } = callsModule;
type ParsedCall = ReturnType<typeof parseCallEvents>["calls"][number];

/** The exact conditions handleCallEvent() uses before following up. */
function shouldFollowUp(c: ParsedCall): boolean {
  if (!c.from) return false;
  if (c.event && c.event !== "terminate") return false;
  if (c.direction === "outbound") return false;
  if (c.answered) return false;
  return true;
}

const callPayload = (call: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA_ID",
    changes: [{
      field: "calls",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "919000000010", phone_number_id: "PNID" },
        calls: [call],
      },
    }],
  }],
});

const messagePayload = {
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA_ID",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "919000000010", phone_number_id: "PNID" },
        messages: [{ id: "wamid.X", from: "919876543210", type: "text", text: { body: "hi" } }],
      },
    }],
  }],
};

interface Case { name: string; run: () => void }
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

// ── Parsing ────────────────────────────────────────────────────────────────

test("ordinary message payload → no call processing", () => {
  const { calls } = parseCallEvents(messagePayload);
  assert.equal(calls.length, 0);
});

test("malformed / empty bodies → no crash, no calls", () => {
  for (const body of [null, undefined, {}, { entry: null }, { entry: [{}] },
                      { entry: [{ changes: [{ field: "calls", value: {} }] }] }]) {
    const { calls } = parseCallEvents(body as any);
    assert.equal(calls.length, 0);
  }
});

test("inbound missed call (terminate/REJECTED) → detected as missed", () => {
  const { calls } = parseCallEvents(callPayload({
    id: "wacid.MISSED1", from: "919876543210", to: "919000000010",
    event: "terminate", direction: "inbound", status: "REJECTED",
    timestamp: "2026-08-11T03:14:00Z",
  }));
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.answered, false);
  assert.equal(c.direction, "inbound");
  assert.equal(c.from, "919876543210");
  assert.equal(c.to, "919000000010");
  assert.equal(shouldFollowUp(c), true);
});

test("FAILED call → treated as missed", () => {
  const { calls } = parseCallEvents(callPayload({
    id: "wacid.FAILED1", from: "919876543210", event: "terminate",
    direction: "inbound", status: "FAILED",
  }));
  assert.equal(calls[0].answered, false);
  assert.equal(shouldFollowUp(calls[0]), true);
});

test("answered call (COMPLETED + duration) → no follow-up", () => {
  const { calls } = parseCallEvents(callPayload({
    id: "wacid.DONE1", from: "919876543210", event: "terminate",
    direction: "inbound", status: "COMPLETED",
    start_time: "2026-08-11T03:14:00Z", end_time: "2026-08-11T03:14:42Z", duration: 42,
  }));
  assert.equal(calls[0].answered, true);
  assert.equal(calls[0].durationSecs, 42);
  assert.equal(shouldFollowUp(calls[0]), false);
});

test("business-initiated (outbound) call → no student follow-up", () => {
  for (const direction of ["outbound", "BUSINESS_INITIATED"]) {
    const { calls } = parseCallEvents(callPayload({
      id: `wacid.OUT_${direction}`, from: "919876543210", event: "terminate",
      direction, status: "REJECTED",
    }));
    assert.equal(calls[0].direction, "outbound", `direction=${direction}`);
    assert.equal(shouldFollowUp(calls[0]), false, `direction=${direction}`);
  }
});

test("connect event (ringing) → recorded but no follow-up yet", () => {
  const { calls } = parseCallEvents(callPayload({
    id: "wacid.RING1", from: "919876543210", event: "connect", direction: "inbound",
    session: { sdp_type: "offer", sdp: "v=0..." },
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, "connect");
  // Following up here would message a student whose phone is still ringing.
  assert.equal(shouldFollowUp(calls[0]), false);
});

test("unknown direction defaults to inbound (a student is not skipped)", () => {
  const { calls } = parseCallEvents(callPayload({
    id: "wacid.NODIR", from: "919876543210", event: "terminate", status: "REJECTED",
  }));
  assert.equal(calls[0].direction, "inbound");
  assert.equal(shouldFollowUp(calls[0]), true);
});

test("call with no caller number → never followed up", () => {
  const { calls } = parseCallEvents(callPayload({
    id: "wacid.NOFROM", event: "terminate", direction: "inbound", status: "REJECTED",
  }));
  assert.equal(shouldFollowUp(calls[0]), false);
});

test("multiple calls in one payload → all parsed", () => {
  const body = callPayload({ id: "a", from: "9198", event: "terminate", status: "REJECTED" });
  (body.entry[0].changes[0].value.calls as unknown[]).push(
    { id: "b", from: "9199", event: "terminate", status: "COMPLETED", duration: 10 },
  );
  const { calls } = parseCallEvents(body);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].answered, false);
  assert.equal(calls[1].answered, true);
});

test("dedupe key is per call AND per event", () => {
  // handleCallEvent stores `${callId}:${event}`, so a connect and its later
  // terminate are distinct rows while a redelivery of either collides on the
  // UNIQUE(wa_call_id) constraint.
  const key = (c: ParsedCall) => `${c.callId}:${c.event || "x"}`;
  const [connect] = parseCallEvents(callPayload({ id: "wacid.Z", from: "9198", event: "connect" })).calls;
  const [terminate] = parseCallEvents(callPayload({ id: "wacid.Z", from: "9198", event: "terminate", status: "REJECTED" })).calls;
  assert.notEqual(key(connect), key(terminate));
  const [redelivered] = parseCallEvents(callPayload({ id: "wacid.Z", from: "9198", event: "terminate", status: "REJECTED" })).calls;
  assert.equal(key(terminate), key(redelivered));
});

async function main() {
  let failed = 0;
  for (const c of cases) {
    try {
      c.run();
      console.log(`  ok  - ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  - ${c.name}`);
      console.error(err);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
