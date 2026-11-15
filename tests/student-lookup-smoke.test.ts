/**
 * Mocked-DB smoke test for the admin student lookup (answerStudentLookup).
 *
 * Live failure, 2026-10-26: the owner asked "Did she paid" about
 * Sample Student (9876543201) and the bot replied "Let me check her records."
 * and never answered. These tests drive the real answerStudentLookup
 * against an in-memory fake Supabase client and capture the exact text
 * the bot would send on WhatsApp (the real WhatsApp client is mocked
 * out with node:test mock.module — no network, no real sends).
 *
 * The `@/` alias used inside src/ is resolved by the hook in
 * ./helpers/test-alias-hooks.mjs, registered before the unit under test
 * is imported.
 */
import { strict as assert } from "node:assert";
import { register } from "node:module";
import { mock, test } from "node:test";

register("./helpers/test-alias-hooks.mjs", import.meta.url);

const sent: { to: string; body: string }[] = [];
mock.module("@/lib/whatsapp/client", {
  cache: false,
  namedExports: {
    sendWhatsAppText: async (to: string, body: string) => {
      sent.push({ to, body });
      return true;
    },
  },
});

const { answerStudentLookup } = await import("../src/lib/whatsapp/student-lookup.ts");

// ── Minimal in-memory Supabase stand-in ────────────────────────────────
// Only the query shapes the lookup path actually uses: select/eq/not/
// order/maybeSingle (awaited directly or via maybeSingle) and upsert.
// Rows are plain objects; select() column lists are ignored.

type Row = Record<string, unknown>;

class FakeQuery {
  private rows: Row[];
  private filters: ((r: Row) => boolean)[] = [];
  private sortKey: string | null = null;
  private sortAsc = true;

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  select(): this {
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push((r) => r[col] === value);
    return this;
  }

  not(col: string, op: string, value: unknown): this {
    if (op === "is" && value === null) this.filters.push((r) => r[col] !== null && r[col] !== undefined);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.sortKey = col;
    this.sortAsc = opts?.ascending !== false;
    return this;
  }

  private run(): Row[] {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.sortKey) {
      const key = this.sortKey;
      out = [...out].sort((a, b) => {
        const av = String(a[key] ?? "");
        const bv = String(b[key] ?? "");
        return this.sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return out;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.run()[0] ?? null, error: null };
  }

  then(resolve: (v: { data: Row[]; error: null }) => void, reject: (e: unknown) => void): void {
    Promise.resolve({ data: this.run(), error: null }).then(resolve, reject);
  }
}

class FakeDb {
  tables: Record<string, Row[]>;

  constructor(tables: Record<string, Row[]>) {
    this.tables = tables;
  }

  from(table: string): {
    select: (...args: unknown[]) => FakeQuery;
    upsert: (row: Row, opts?: { onConflict?: string }) => Promise<{ data: Row | null; error: null }>;
  } {
    const rows = this.tables[table] ?? (this.tables[table] = []);
    return {
      select: (..._args: unknown[]) => new FakeQuery(rows),
      upsert: async (row: Row, _opts?: { onConflict?: string }) => {
        const key = (row.phone as string | undefined) ?? (row.id as string | undefined);
        const existing = key ? rows.find((r) => r.phone === key || r.id === key) : undefined;
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row });
        return { data: row, error: null };
      },
    };
  }
}

const ADMIN = "9876543202";

function seedDb(): FakeDb {
  return new FakeDb({
    profiles: [
      {
        id: "shiv-id",
        phone: "9876543201",
        full_name: null,
        role: "student",
        is_profile_complete: false,
        created_at: "2026-10-15T06:05:49.937753+00:00",
        batches: null,
      },
      {
        id: "paid-id",
        phone: "9876543203",
        full_name: "Test Student",
        role: "student",
        is_profile_complete: true,
        created_at: "2026-10-01T05:00:00.000Z",
        batches: { name: "GNIT Batch 2", college: "GNIT" },
      },
    ],
    payments: [
      {
        id: "pay-1",
        student_id: "paid-id",
        status: "approved",
        amount: 2200,
        created_at: "2026-10-02T05:00:00.000Z",
        utr_number: null,
        review_notes: null,
        payment_method: "razorpay",
        razorpay_order_id: "order_test123",
        razorpay_payment_id: null,
        cashfree_order_id: null,
        cashfree_payment_id: null,
        phonepe_merchant_txn_id: null,
        phonepe_txn_id: null,
      },
    ],
    whatsapp_moderation: [],
  });
}

test("'Did she paid' after a lookup answers about Sample Student: no payment record", async () => {
  const db = seedDb();
  sent.length = 0;

  // The lookup itself: bare number, as the owner sent it.
  assert.equal(await answerStudentLookup(db as never, ADMIN, "9876543201"), true);
  assert.match(sent[0].body, /Not registered yet/);
  assert.match(sent[0].body, /No payment yet/);

  // The reported failure, word for word: "Did she paid".
  assert.equal(await answerStudentLookup(db as never, ADMIN, "Did she paid"), true);
  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /Not registered yet/);
  assert.match(sent[1].body, /No payment yet/);
  assert.doesNotMatch(sent[1].body, /Let me check/);
});

test("'Did <name> pay?' answers that one student, with gateway", async () => {
  const db = seedDb();
  sent.length = 0;

  assert.equal(await answerStudentLookup(db as never, ADMIN, "Did Test Student pay?"), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Test Student/);
  assert.match(sent[0].body, /✅ Paid ₹2,200 on 2 Oct 2026 via Razorpay/);
  assert.match(sent[0].body, /GNIT Batch 2 \(GNIT\)/);

  // The follow-up memory was set by the name lookup too.
  assert.equal(await answerStudentLookup(db as never, ADMIN, "Has she paid?"), true);
  assert.match(sent[1].body, /✅ Paid ₹2,200 on 2 Oct 2026 via Razorpay/);
});

test("a bare payment question with no prior context names nobody and answers about nobody", async () => {
  const db = seedDb();
  sent.length = 0;

  assert.equal(await answerStudentLookup(db as never, ADMIN, "Did she pay?"), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /send their 10-digit phone number first/);
  // No student is named and no payment is stated. (9876543201 appears in
  // the reply only as the usage example in FOLLOWUP_NO_CONTEXT — it is
  // the example number, not an answer about her.)
  assert.doesNotMatch(sent[0].body, /Test Student|Sample Student|9876543203/);
  assert.doesNotMatch(sent[0].body, /Paid ₹/);
});

test("the lookup memory survives an intervening stats question", async () => {
  const db = seedDb();
  sent.length = 0;

  assert.equal(await answerStudentLookup(db as never, ADMIN, "9876543201"), true);
  // Another admin question overwrites whatsapp_moderation.last_intent
  // (ADMIN_REG_STATS), exactly as the live stats handler does — the
  // pronoun memory must still resolve through the draft-key backup.
  const mod = db.tables.whatsapp_moderation[0] as Row;
  mod.last_intent = "ADMIN_REG_STATS";
  mod.last_intent_at = new Date().toISOString();

  assert.equal(await answerStudentLookup(db as never, ADMIN, "Did she pay?"), true);
  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /Not registered yet/);
  assert.match(sent[1].body, /No payment yet/);
});
