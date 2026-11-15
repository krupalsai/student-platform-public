/**
 * Admin → one student media relay.
 *
 * An admin photographs a receipt and sends it to the bot captioned
 *   MESSAGE 9876543210 here is your receipt
 * and the bot forwards it to exactly that student.
 *
 * Two things decide whether it reaches the right person, and both are pure:
 *   1. parseIncomingWhatsApp() — does an image/document webhook even surface
 *      its media id and caption?
 *   2. parseRelayCommand()     — which number did the caption name?
 * The send itself is Meta's API and is not mocked; these tests pin the parse,
 * which is where every historical bug in this area lived (bug #33 corrupted a
 * real 10-digit mobile beginning with 91).
 *
 * Run with: npx tsx scripts/test-admin-media-relay.ts
 */
import assert from "node:assert/strict";

// Well-formed dummies set BEFORE the requires below. admin-photo-relay pulls in
// storage.ts, which throws at import time without Cloudinary config, and the
// Supabase client is constructed at module load. Nothing here makes a network
// call — everything under test is pure.
process.env.NEXT_PUBLIC_SUPABASE_URL  = "https://dummy.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";
process.env.CLOUDINARY_CLOUD_NAME     = "dummy-cloud";
process.env.CLOUDINARY_API_KEY        = "dummy-key";
process.env.CLOUDINARY_API_SECRET     = "dummy-secret";

// require(), not import: the env vars above must be set before these load, and
// static imports would be hoisted above them.
/* eslint-disable @typescript-eslint/no-require-imports */
const relay = require("../src/lib/whatsapp/admin-photo-relay") as typeof import("../src/lib/whatsapp/admin-photo-relay");
const parserModule = require("../src/lib/whatsapp/parser") as typeof import("../src/lib/whatsapp/parser");
/* eslint-enable @typescript-eslint/no-require-imports */

const { parseRelayCommand, extFor } = relay;
const { parseIncomingWhatsApp } = parserModule;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}\n     ${(e as Error).message}`);
  }
}

const webhook = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messages: [message] } }] }],
});

console.log("\n── webhook parsing ──────────────────────────────────────────");

test("an image carries its media id and caption", () => {
  const p = parseIncomingWhatsApp(webhook({
    id: "wamid.1", from: "919012345678", type: "image",
    image: { id: "MEDIA_1", caption: "MESSAGE 9876543210 your receipt", mime_type: "image/jpeg" },
  }));
  assert.equal(p?.imageId, "MEDIA_1");
  assert.equal(p?.text, "MESSAGE 9876543210 your receipt");
  assert.equal(p?.documentId ?? null, null);
});

test("a document carries its media id, filename and caption", () => {
  const p = parseIncomingWhatsApp(webhook({
    id: "wamid.2", from: "919012345678", type: "document",
    document: { id: "MEDIA_2", filename: "fee-receipt.pdf", caption: "MESSAGE 9876543210 receipt" },
  }));
  assert.equal(p?.documentId, "MEDIA_2");
  assert.equal(p?.documentFilename, "fee-receipt.pdf");
  assert.equal(p?.text, "MESSAGE 9876543210 receipt");
  assert.equal(p?.imageId, null);
});

test("a captionless photo still surfaces its media id (so we can reply with usage)", () => {
  const p = parseIncomingWhatsApp(webhook({
    id: "wamid.3", from: "919012345678", type: "image", image: { id: "MEDIA_3" },
  }));
  assert.equal(p?.imageId, "MEDIA_3");
  assert.equal(p?.text, null);
});

test("a plain text message is untouched by the document branch", () => {
  const p = parseIncomingWhatsApp(webhook({
    id: "wamid.4", from: "919012345678", type: "text", text: { body: "STATUS" },
  }));
  assert.equal(p?.text, "STATUS");
  assert.equal(p?.documentId ?? null, null);
  assert.equal(p?.imageId, null);
});

console.log("\n── caption parsing ──────────────────────────────────────────");

test("a normal caption names the student and the message", () => {
  const c = parseRelayCommand("MESSAGE 9876543210 your payment is approved");
  assert.equal(c.kind, "ok");
  assert.equal(c.kind === "ok" && c.phone, "9876543210");
  assert.equal(c.kind === "ok" && c.body, "your payment is approved");
});

test("a caption that isn't a MESSAGE command is left alone", () => {
  // Must NOT be handled — normal image handling (student screenshots) has to run.
  assert.equal(parseRelayCommand("here is the receipt").kind, "not_a_command");
  assert.equal(parseRelayCommand(null).kind, "not_a_command");
  assert.equal(parseRelayCommand("").kind, "not_a_command");
  assert.equal(parseRelayCommand("MESSAGES ARE FUN").kind, "not_a_command");
});

test("bare MESSAGE gets usage help, not silence", () => {
  assert.equal(parseRelayCommand("MESSAGE").kind, "malformed");
  assert.equal(parseRelayCommand("message   ").kind, "malformed");
});

test("lowercase and mixed case work", () => {
  assert.equal(parseRelayCommand("message 9876543210 hi").kind, "ok");
  assert.equal(parseRelayCommand("Message 9876543210 hi").kind, "ok");
});

test("no body is allowed — a photo can speak for itself", () => {
  const c = parseRelayCommand("MESSAGE 9876543210");
  assert.equal(c.kind, "ok");
  assert.equal(c.kind === "ok" && c.body, "");
});

test("the 91 country code is stripped from the 12-digit form", () => {
  const c = parseRelayCommand("MESSAGE 919876543210 hi");
  assert.equal(c.kind === "ok" && c.phone, "9876543210");
  const plus = parseRelayCommand("MESSAGE +919876543210 hi");
  assert.equal(plus.kind === "ok" && plus.phone, "9876543210");
});

test("BUG #33: a real 10-digit mobile starting with 91 survives intact", () => {
  const c = parseRelayCommand("MESSAGE 9112345600 hi");
  assert.equal(c.kind, "ok");
  assert.equal(c.kind === "ok" && c.phone, "9112345600", "must NOT be truncated to 12345600");
});

test("spaces and dashes inside the number are tolerated", () => {
  const c = parseRelayCommand("MESSAGE 98765-43210 hi");
  assert.equal(c.kind === "ok" && c.phone, "9876543210");
});

test("a wrong-length number never becomes a send", () => {
  // Either outcome puts the admin in front of usage help; what must never
  // happen is a photo going to a number nobody typed.
  for (const bad of ["MESSAGE 98765 hi", "MESSAGE 123456789012345 hi", "MESSAGE 12345678901 hi"]) {
    assert.notEqual(parseRelayCommand(bad).kind, "ok", bad);
  }
});

test("a multi-line message keeps its line breaks", () => {
  const c = parseRelayCommand("MESSAGE 9876543210 line one\nline two");
  assert.equal(c.kind === "ok" && c.body, "line one\nline two");
});

console.log("\n── file extension ───────────────────────────────────────────");

test("a real filename's extension wins", () => {
  assert.equal(extFor("application/octet-stream", "fees.docx", false), "docx");
  assert.equal(extFor(undefined, "Route Map.PDF", false), "pdf");
});

test("mime subtype is the fallback", () => {
  assert.equal(extFor("image/png", null, true), "png");
  assert.equal(extFor("application/pdf", null, false), "pdf");
});

test("a junk mime type doesn't produce a junk extension", () => {
  // "vnd.openxmlformats-officedocument..." is far too long to be an extension —
  // handing that to Cloudinary would make an unopenable file.
  assert.equal(
    extFor("application/vnd.openxmlformats-officedocument.wordprocessingml.document", null, false),
    "bin",
  );
  assert.equal(extFor(undefined, "no-extension-here", true), "jpg");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
