/**
 * Part 1 verification — calls the ACTUAL route handler (not a
 * reimplementation) with constructed NextRequest objects, covering the
 * checklist from the security review:
 *   1. Valid signature -> accepted
 *   2. Invalid signature -> rejected (401)
 *   3. Missing signature -> current behavior with/without WHATSAPP_APP_SECRET set
 *
 * Run with: npx tsx scripts/test-whatsapp-webhook-auth.ts
 *
 * Note on scope: this exercises the auth gate for real. It does NOT hit a
 * live Supabase or WhatsApp API — the message bodies used are deliberately
 * shaped so parseIncomingWhatsApp() returns null (no "messages" array),
 * so execution never reaches handleIncomingWhatsAppMessage/DB calls. That
 * keeps this test hermetic and safe to run anywhere. Full end-to-end
 * message-processing verification (item 4 on the checklist) is a separate,
 * code-review-based check — noted in the summary, not claimed as tested here.
 */
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

// Dummy but well-formed values — never used for a real network call in
// this test, since the payload never parses into a real message.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dummy.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";
process.env.WHATSAPP_VERIFY_TOKEN = "dummy-verify-token";
// The route's import chain reaches storage.ts, which THROWS at module load
// when these are absent — so all 7 checks here were failing before they ever
// ran, leaving the signature gate unverified. Dummies suffice: no upload
// happens on any path this test exercises.
process.env.CLOUDINARY_CLOUD_NAME = "dummy-cloud";
process.env.CLOUDINARY_API_KEY = "dummy-key";
process.env.CLOUDINARY_API_SECRET = "dummy-secret";

const HARMLESS_BODY = JSON.stringify({ entry: [{ changes: [{ value: { field: "not_a_message" } }] }] });

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

test("WHATSAPP_APP_SECRET set + valid signature -> 200 (accepted)", async () => {
  process.env.WHATSAPP_APP_SECRET = "test_app_secret";
  const mod = await import(`../src/app/api/whatsapp/webhook/route.ts?t=${Date.now()}-1`);
  const req = new Request("https://example.com/api/whatsapp/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": sign(HARMLESS_BODY, "test_app_secret") },
    body: HARMLESS_BODY,
  });
  const res = await mod.POST(req as any);
  assert.equal(res.status, 200);
});

test("WHATSAPP_APP_SECRET set + invalid signature -> 401 (rejected)", async () => {
  process.env.WHATSAPP_APP_SECRET = "test_app_secret";
  const mod = await import(`../src/app/api/whatsapp/webhook/route.ts?t=${Date.now()}-2`);
  const req = new Request("https://example.com/api/whatsapp/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": sign(HARMLESS_BODY, "WRONG_secret") },
    body: HARMLESS_BODY,
  });
  const res = await mod.POST(req as any);
  assert.equal(res.status, 401);
});

test("WHATSAPP_APP_SECRET set + missing signature header -> 401 (rejected)", async () => {
  process.env.WHATSAPP_APP_SECRET = "test_app_secret";
  const mod = await import(`../src/app/api/whatsapp/webhook/route.ts?t=${Date.now()}-3`);
  const req = new Request("https://example.com/api/whatsapp/webhook", {
    method: "POST",
    body: HARMLESS_BODY,
  });
  const res = await mod.POST(req as any);
  assert.equal(res.status, 401);
});

test("WHATSAPP_APP_SECRET set + tampered body (valid sig for different body) -> 401 (rejected)", async () => {
  process.env.WHATSAPP_APP_SECRET = "test_app_secret";
  const mod = await import(`../src/app/api/whatsapp/webhook/route.ts?t=${Date.now()}-4`);
  const req = new Request("https://example.com/api/whatsapp/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": sign(HARMLESS_BODY, "test_app_secret") },
    body: HARMLESS_BODY + "TAMPERED",
  });
  const res = await mod.POST(req as any);
  assert.equal(res.status, 401);
});

test("WHATSAPP_APP_SECRET UNSET + no signature header -> 200 (current pre-rollout behavior, not yet enforced)", async () => {
  // Deliberately run in a fully separate process — a same-process dynamic
  // import with a cache-busting query string is not reliable for
  // resetting a module-level `const` read from process.env under tsx.
  // Verified this the hard way: an earlier version of this test failed
  // here even though manual isolation (a genuinely fresh process) proved
  // the actual route code is correct.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");

  const scriptPath = path.join(process.cwd(), ".tmp-unset-secret-check.mjs");
  const routePath = path.join(process.cwd(), "src/app/api/whatsapp/webhook/route.ts");
  fs.writeFileSync(
    scriptPath,
    `process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dummy.supabase.co";\n` +
    `process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";\n` +
    `process.env.WHATSAPP_VERIFY_TOKEN = "dummy-verify-token";\n` +
    `process.env.CLOUDINARY_CLOUD_NAME = "dummy-cloud";\n` +
    `process.env.CLOUDINARY_API_KEY = "dummy-key";\n` +
    `process.env.CLOUDINARY_API_SECRET = "dummy-secret";\n` +
    `const mod = await import(${JSON.stringify("file://" + routePath)});\n` +
    `const req = new Request("https://example.com/api/whatsapp/webhook", { method: "POST", body: ${JSON.stringify(HARMLESS_BODY)} });\n` +
    `const res = await mod.POST(req);\n` +
    `console.log(res.status);\n`
  );
  try {
    const childEnv = { ...process.env };
    delete childEnv.WHATSAPP_APP_SECRET; // must NOT inherit this from the parent's earlier test cases
    const out = execFileSync("npx", ["tsx", scriptPath], { encoding: "utf8", env: childEnv });
    assert.equal(out.trim(), "200");
  } finally {
    fs.unlinkSync(scriptPath);
  }
});

test("GET handshake still works (hub.verify_token) — unaffected by this change", async () => {
  process.env.WHATSAPP_APP_SECRET = "test_app_secret";
  const mod = await import(`../src/app/api/whatsapp/webhook/route.ts?t=${Date.now()}-6`);
  const url = "https://example.com/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=dummy-verify-token&hub.challenge=abc123";
  const req = new Request(url, { method: "GET" });
  const res = await mod.GET(req as any);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, "abc123");
});

test("WHATSAPP_APP_SECRET with trailing newline (common copy-paste artifact) + correctly-signed request -> 200 (trim fix works)", async () => {
  // Simulates pasting a secret into Vercel with a trailing newline —
  // common when copying from a terminal or a source that appends one.
  process.env.WHATSAPP_APP_SECRET = "test_app_secret\n";
  const mod = await import(`../src/app/api/whatsapp/webhook/route.ts?t=${Date.now()}-7`);
  // Signed with the TRIMMED value, matching what Meta actually sends
  // (Meta doesn't know or care about our env var's whitespace — it signs
  // with the real secret exactly as issued, no trailing newline).
  const req = new Request("https://example.com/api/whatsapp/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": sign(HARMLESS_BODY, "test_app_secret") },
    body: HARMLESS_BODY,
  });
  const res = await mod.POST(req as any);
  assert.equal(res.status, 200);
});

async function main() {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.run();
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
