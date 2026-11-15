/**
 * Tests for the two admin count paths that disagreed with the batch views.
 *
 * Gap 1 — Colleges page said GNIT 50 while the batch views sum to 49:
 * the old count used the profile's own `college` column, so Krupal (profile
 * college GNIT, enrolled in GNITC Batch 2) was counted under GNIT.
 * countStudentsInCollegeBatches counts by the BATCH's college instead.
 *
 * Gap 2 — GNIT Batch 2 detail card said 23 Total Students while the
 * list/summary said 25: the old stats route filtered enrolled profiles to
 * role === "student", dropping the 2 batch admins (Admin A, Admin B).
 * computeBatchStats counts every completed profile in the batch.
 *
 * Fixtures mirror the live numbers: GNIT B1 24, GNIT B2 25, GNITC B1 34,
 * GNITC B2 22 — 105 completed profiles in non-archived batches.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { countStudentsInCollegeBatches } from "../src/lib/services/college-counts.ts";
import { computeBatchStats } from "../src/lib/services/batch-stats.ts";
import { bestPaymentPerStudent } from "../src/lib/services/payments.ts";

type Row = Record<string, unknown>;

class FakeQuery {
  private rows: Row[];
  private filters: ((r: Row) => boolean)[] = [];

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  select(_cols?: string, _opts?: { count?: string; head?: boolean }): this {
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push((r) => r[col] === value);
    return this;
  }

  neq(col: string, value: unknown): this {
    this.filters.push((r) => r[col] !== value);
    return this;
  }

  not(col: string, op: string, value: unknown): this {
    if (op === "is" && value === null) {
      this.filters.push((r) => r[col] !== null && r[col] !== undefined);
      return this;
    }
    throw new Error(`unsupported not() ${op}`);
  }

  in(col: string, values: unknown[]): this {
    this.filters.push((r) => values.includes(r[col]));
    return this;
  }

  order(): this {
    return this;
  }

  // Supabase builders are thenable; awaiting the chain runs the query.
  then(resolve: (v: { data: Row[]; count: number; error: null }) => void): void {
    const data = this.rows.filter((r) => this.filters.every((f) => f(r)));
    resolve({ data, count: data.length, error: null });
  }
}

class FakeDb {
  private tables: Record<string, Row[]>;
  constructor(tables: Record<string, Row[]>) {
    this.tables = tables;
  }
  from(table: string): FakeQuery {
    return new FakeQuery(this.tables[table] ?? []);
  }
}

const asDb = (db: FakeDb) => db as never;

// --- fixtures -------------------------------------------------------------

const batches: Row[] = [
  { id: "gnit-b1", college: "GNIT", status: "active" },
  { id: "gnit-b2", college: "GNIT", status: "active" },
  { id: "gnitc-b1", college: "GNITC", status: "active" },
  { id: "gnitc-b2", college: "GNITC", status: "active" },
  { id: "gnit-arch", college: "GNIT", status: "archived" },
];

function profile(id: string, batchId: string | null, college: string, role = "student", complete = true): Row {
  return { id, batch_id: batchId, college, role, is_profile_complete: complete };
}

const profiles: Row[] = [];
// GNIT B1: 24 students.
for (let i = 0; i < 24; i++) profiles.push(profile(`gnit-b1-${i}`, "gnit-b1", "GNIT"));
// GNIT B2: 23 students + 2 batch admins (Admin A, Admin B).
for (let i = 0; i < 23; i++) profiles.push(profile(`gnit-b2-${i}`, "gnit-b2", "GNIT"));
profiles.push(profile("admin-a", "gnit-b2", "GNIT", "admin"));
profiles.push(profile("admin-b", "gnit-b2", "GNIT", "admin"));
// GNITC B1: 34 students.
for (let i = 0; i < 34; i++) profiles.push(profile(`gnitc-b1-${i}`, "gnitc-b1", "GNITC"));
// GNITC B2: 20 students + 1 batch admin + Krupal (profile college GNIT,
// enrolled in GNITC Batch 2 — the row the old count misplaced under GNIT).
for (let i = 0; i < 20; i++) profiles.push(profile(`gnitc-b2-${i}`, "gnitc-b2", "GNITC"));
profiles.push(profile("gnitc-b2-admin", "gnitc-b2", "GNITC", "admin"));
profiles.push(profile("krupal", "gnitc-b2", "GNIT", "super_admin"));
// Must not count anywhere: archived batch, no batch, incomplete profile.
profiles.push(profile("archived-student", "gnit-arch", "GNIT"));
profiles.push(profile("no-batch", null, "GNIT"));
profiles.push(profile("incomplete", "gnit-b1", "GNIT", "student", false));

const db = new FakeDb({ batches, profiles });

// --- Gap 1: college counts by batch's college ------------------------------

test("Colleges count matches the batch views: GNIT 49, GNITC 56", async () => {
  assert.equal(await countStudentsInCollegeBatches(asDb(db), "GNIT"), 49);
  assert.equal(await countStudentsInCollegeBatches(asDb(db), "GNITC"), 56);
});

test("Krupal counts under GNITC (his batch), not GNIT (his profile college)", async () => {
  // The old profile-college count gave GNIT 50 / GNITC 55. With the fix the
  // 105 enrolled profiles split 49 / 56 — total unchanged.
  const gnit = await countStudentsInCollegeBatches(asDb(db), "GNIT");
  const gnitc = await countStudentsInCollegeBatches(asDb(db), "GNITC");
  assert.equal(gnit + gnitc, 105);
});

test("archived batches, batch-less and incomplete profiles count for no college", async () => {
  assert.equal(await countStudentsInCollegeBatches(asDb(db), "GNIT"), 49);
  assert.equal(await countStudentsInCollegeBatches(asDb(db), "BIET"), 0);
});

// --- Gap 2: batch stats count every enrolled profile -----------------------

function enrolled(batchId: string): { id: string; role: string }[] {
  return (profiles as { id: string; batch_id: string | null; role: string; is_profile_complete: boolean }[])
    .filter((p) => p.batch_id === batchId && p.is_profile_complete)
    .map((p) => ({ id: p.id, role: p.role }));
}

test("GNIT Batch 2 card says 25 and counts the admin's approved payment", async () => {
  const rawPayments = [
    // Admin B's approved ₹2,200, then a later pg_pending retry order — the
    // approved payment must still be the one that counts.
    { student_id: "admin-b", status: "approved", amount: 2200, created_at: "2026-11-01T10:00:00Z" },
    { student_id: "admin-b", status: "pg_pending", amount: 2200, created_at: "2026-11-01T10:00:10Z" },
  ];
  const stats = computeBatchStats(enrolled("gnit-b2"), bestPaymentPerStudent(rawPayments));
  assert.deepEqual(stats, {
    total_students: 25,
    paid_students: 1,
    not_paid_students: 24,
    failed_payments: 0,
    total_collected: 2200,
  });
});

test("GNIT Batch 1 says 24 and GNITC Batch 2 says 22", async () => {
  assert.equal(computeBatchStats(enrolled("gnit-b1"), {}).total_students, 24);
  const gnitcB2 = computeBatchStats(
    enrolled("gnitc-b2"),
    bestPaymentPerStudent([
      { student_id: "gnitc-b2-0", status: "approved", amount: 2200, created_at: "2026-11-02T10:00:00Z" },
      { student_id: "gnitc-b2-1", status: "approved", amount: 2200, created_at: "2026-11-02T11:00:00Z" },
    ]),
  );
  assert.deepEqual(gnitcB2, {
    total_students: 22,
    paid_students: 2,
    not_paid_students: 20,
    failed_payments: 0,
    total_collected: 4400,
  });
});

test("a pg_failed best payment is its own bucket, not 'not paid'", async () => {
  const stats = computeBatchStats(
    [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ],
    bestPaymentPerStudent([
      { student_id: "a", status: "approved", amount: 2200, created_at: "2026-11-03T10:00:00Z" },
      { student_id: "b", status: "pg_failed", amount: 2200, created_at: "2026-11-03T10:00:00Z" },
    ]),
  );
  assert.deepEqual(stats, {
    total_students: 3,
    paid_students: 1,
    not_paid_students: 1,
    failed_payments: 1,
    total_collected: 2200,
  });
});

test("an empty batch is all zeros", async () => {
  assert.deepEqual(computeBatchStats([], {}), {
    total_students: 0,
    paid_students: 0,
    not_paid_students: 0,
    failed_payments: 0,
    total_collected: 0,
  });
});
