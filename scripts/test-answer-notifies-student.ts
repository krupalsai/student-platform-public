/**
 * Verifies the self-learning loop actually notifies the ORIGINAL student
 * who asked, not just future askers. Previously: FAQ got created, future
 * students benefited automatically, but the person who actually asked was
 * left on "you'll hear back soon" forever unless manually messaged.
 *
 * Run with: npx tsx scripts/test-answer-notifies-student.ts
 */
import assert from "node:assert/strict";

process.env.WHATSAPP_PHONE_NUMBER_ID = "dummy_phone_id";
process.env.WHATSAPP_ACCESS_TOKEN = "dummy_token";
process.env.WHATSAPP_ADMIN_NUMBER = "9000000000";
// admin.ts's import chain reaches src/lib/supabase/server.ts, which throws
// at module load without these — every case failed with that env error
// instead of actually testing anything (bug #55).
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dummy.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key";

function makeFakeDb(uqRow: any) {
  const updates: any[] = [];
  const inserts: any[] = [];

  function selectChain(resultRow: any) {
    const chain: any = {
      eq(_c: string, _v: any) {
        return chain;
      },
      async maybeSingle() {
        return { data: resultRow, error: null };
      },
    };
    return chain;
  }

  return {
    from(table: string) {
      return {
        select(_cols: string) {
          // Both call sites this test needs to support look up by id/
          // short_id — same fake row works for either since this test
          // only ever has one relevant row in flight at a time.
          return selectChain(table === "unknown_questions" ? uqRow : null);
        },
        insert(row: any) {
          inserts.push({ table, row });
          return { select() { return { async single() { return { data: { id: "faq-1" }, error: null }; } }; } };
        },
        update(fields: any) {
          return {
            eq(_c: string, _v: any) {
              updates.push({ table, fields });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    _updates: updates,
    _inserts: inserts,
  } as any;
}

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

test("ANSWER command sends the answer to the original student's WhatsApp number", async () => {
  const uqRow = { id: "uq-1", question: "How much is the petition fee?", short_id: 104, student_phone: "919876543210" };
  const db = makeFakeDb(uqRow);

  const sentMessages: { to: string; body: string }[] = [];
  const origFetch = global.fetch;
  global.fetch = (async (url: string, opts: { body: string }) => {
    const parsed = JSON.parse(opts.body);
    sentMessages.push({ to: parsed.to, body: parsed.text?.body ?? "" });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  const mod = await import(`../src/lib/whatsapp/admin.ts?t=${Date.now()}`);
  await mod.handleAdminCommand(db, "919000000000", "ANSWER UQ-104\nThe fee is 5000 rupees.");

  global.fetch = origFetch;

  const toStudent = sentMessages.find(m => m.to.includes("9876543210"));
  assert.ok(toStudent, "expected a message sent to the original student's number");
  assert.match(toStudent!.body, /5000 rupees/);
  assert.match(toStudent!.body, /How much is the petition fee/);
});

test("ANSWER command still confirms to admin, and notes when there's no student_phone (Mini App source)", async () => {
  const uqRow = { id: "uq-2", question: "What documents are needed?", short_id: 105, student_phone: null };
  const db = makeFakeDb(uqRow);

  const sentMessages: { to: string; body: string }[] = [];
  const origFetch = global.fetch;
  global.fetch = (async (url: string, opts: { body: string }) => {
    const parsed = JSON.parse(opts.body);
    sentMessages.push({ to: parsed.to, body: parsed.text?.body ?? "" });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;

  const mod = await import(`../src/lib/whatsapp/admin.ts?t=${Date.now()}`);
  await mod.handleAdminCommand(db, "919000000000", "ANSWER UQ-105\nBring your college ID and marksheet.");

  global.fetch = origFetch;

  // Only ONE message should have gone out (to the admin confirming) —
  // no student to notify, and it should say so rather than silently
  // pretending the loop is complete.
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].body, /No WhatsApp number on file/);
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
