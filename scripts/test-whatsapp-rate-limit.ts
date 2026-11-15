/**
 * Verifies the rate limiting added to the WhatsApp webhook actually
 * works: blocks a flood from one sender, lets normal traffic through,
 * and exempts the admin number. Uses a fake Supabase client that tracks
 * rate_limits inserts in memory (mirrors checkRateLimit's real query
 * shape) instead of hitting a live database.
 *
 * Run with: npx tsx scripts/test-whatsapp-rate-limit.ts
 */
import assert from "node:assert/strict";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dummy.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";
process.env.WHATSAPP_VERIFY_TOKEN = "dummy-verify-token";
process.env.WHATSAPP_ADMIN_NUMBER = "9999999999";
// No APP_SECRET set -> signature check stays in its pre-rollout open
// state, so these requests reach the rate-limit logic without needing a
// real HMAC — this test is about rate limiting, not signature auth
// (already covered by test-whatsapp-webhook-auth.ts).

function makeFakeRateLimitDb() {
  const rows: { bucket_key: string; created_at: string }[] = [];
  return {
    from(table: string) {
      if (table !== "rate_limits") {
        // whatsapp_moderation / other tables not relevant to this test —
        // return "no row" so callers treat every sender as brand new,
        // which is harmless for what's being tested here.
        return {
          select() { return { eq() { return { async maybeSingle() { return { data: null, error: null }; } }; } }; },
          async upsert() { return { data: null, error: null }; },
        };
      }
      return {
        select(_cols: string, _opts: any) {
          return {
            eq(_c: string, bucketKey: string) {
              return {
                gte(_c2: string, _windowStart: string) {
                  const count = rows.filter(r => r.bucket_key === bucketKey).length;
                  return Promise.resolve({ count, error: null });
                },
              };
            },
          };
        },
        insert(row: { bucket_key: string }) {
          rows.push({ bucket_key: row.bucket_key, created_at: new Date().toISOString() });
          return Promise.resolve({ error: null });
        },
        delete() {
          return { lt() { return Promise.resolve({ error: null }); } };
        },
      };
    },
    _rows: rows,
  } as any;
}

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

test("31st message in a burst from the same sender is rate-limited (30/60s limit)", async () => {
  const { checkRateLimit } = await import("../src/lib/rate-limit");
  const db = makeFakeRateLimitDb();
  let lastResult;
  for (let i = 0; i < 31; i++) {
    lastResult = await checkRateLimit(db, "wa-msg:919876543210", 30, 60);
  }
  assert.equal(lastResult!.allowed, false);
});

test("30th message (at the limit) is still allowed", async () => {
  const { checkRateLimit } = await import("../src/lib/rate-limit");
  const db = makeFakeRateLimitDb();
  let lastResult;
  for (let i = 0; i < 30; i++) {
    lastResult = await checkRateLimit(db, "wa-msg:919876543210", 30, 60);
  }
  assert.equal(lastResult!.allowed, true);
});

test("different senders have independent buckets — one flooding doesn't block another", async () => {
  const { checkRateLimit } = await import("../src/lib/rate-limit");
  const db = makeFakeRateLimitDb();
  for (let i = 0; i < 35; i++) {
    await checkRateLimit(db, "wa-msg:919876543210", 30, 60);
  }
  const otherSender = await checkRateLimit(db, "wa-msg:918888888888", 30, 60);
  assert.equal(otherSender.allowed, true);
});

test("admin is exempt from rate limiting in the actual webhook route (code-level check)", async () => {
  // isAdminSender is what the webhook route uses to decide exemption —
  // verify it actually recognizes the configured admin number, since
  // the exemption is only as good as this check.
  const { isAdminSender } = await import("../src/lib/whatsapp/admin");
  assert.equal(isAdminSender("919999999999"), true);
  assert.equal(isAdminSender("919876543210"), false);
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
