/**
 * Fake-DB tests for src/lib/services/announcement-seen.ts.
 *
 * The student /announcements page reports viewed cards via
 * POST /api/announcements/seen and the admin announcements screen shows
 * "seen by N" via GET /api/admin/announcements/seen — both go through these
 * two functions. Tests drive the real functions against an in-memory fake
 * Supabase client: no network, no real rows.
 *
 * Only the query shapes the service actually uses are faked:
 * insert() on student_events, and select().eq().eq() with the
 * metadata->>announcement_id JSON filter.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  recordAnnouncementViews,
  countAnnouncementViews,
} from "../src/lib/services/announcement-seen.ts";

type Row = Record<string, unknown>;

class FakeQuery {
  private rows: Row[];
  private filters: ((r: Row) => boolean)[] = [];

  constructor(rows: Row[]) {
    this.rows = rows;
  }

  select(): this {
    return this;
  }

  eq(col: string, value: unknown): this {
    if (col.includes("->>")) {
      // PostgREST JSON extraction: "metadata->>announcement_id"
      const [base, key] = col.split("->>");
      this.filters.push(
        (r) => (r[base] as Row | null)?.[key] === value,
      );
    } else {
      this.filters.push((r) => r[col] === value);
    }
    return this;
  }

  insert(row: Row): { error: null } {
    this.rows.push({ ...row });
    return { error: null };
  }

  // The service awaits the bare select().eq().eq() chain (real Supabase
  // builders are thenable), so resolve the filtered rows when awaited.
  then(resolve: (v: { data: Row[]; error: null }) => void): void {
    resolve({
      data: this.rows.filter((r) => this.filters.every((f) => f(r))),
      error: null,
    });
  }
}

class FakeDb {
  tables: Record<string, Row[]> = { student_events: [] };

  from(table: string): FakeQuery {
    if (!this.tables[table]) this.tables[table] = [];
    return new FakeQuery(this.tables[table]);
  }
}

const PROFILE = { id: "student-1", batch_id: "batch-1", college: "GNITC" };
const ANN_A = "00000000-0000-0000-0000-000000000001";
const ANN_B = "00000000-0000-0000-0000-000000000002";

test("recordAnnouncementViews inserts one announcement.viewed event per id", async () => {
  const db = new FakeDb() as never;
  const n = await recordAnnouncementViews(db, PROFILE, [ANN_A, ANN_B]);
  assert.equal(n, 2);
  const rows = (db as unknown as FakeDb).tables.student_events;
  assert.equal(rows.length, 2);
  for (const [i, id] of [ANN_A, ANN_B].entries()) {
    assert.equal(rows[i].event_type, "announcement.viewed");
    assert.equal(rows[i].page, "/announcements");
    assert.equal(rows[i].student_id, "student-1");
    assert.equal(rows[i].batch_id, "batch-1");
    assert.equal(rows[i].college, "GNITC");
    assert.deepEqual(rows[i].metadata, { announcement_id: id });
  }
});

test("recordAnnouncementViews with no ids inserts nothing", async () => {
  const db = new FakeDb() as never;
  const n = await recordAnnouncementViews(db, PROFILE, []);
  assert.equal(n, 0);
  assert.equal((db as unknown as FakeDb).tables.student_events.length, 0);
});

test("countAnnouncementViews counts distinct students, ignoring dupes and other events", async () => {
  const db = new FakeDb();
  db.tables.student_events = [
    { student_id: "s1", event_type: "announcement.viewed", metadata: { announcement_id: ANN_A } },
    { student_id: "s1", event_type: "announcement.viewed", metadata: { announcement_id: ANN_A } },
    { student_id: "s2", event_type: "announcement.viewed", metadata: { announcement_id: ANN_A } },
    { student_id: "s3", event_type: "announcement.viewed", metadata: { announcement_id: ANN_B } },
    // Noise that must not leak into the counts:
    { student_id: "s9", event_type: "dashboard.opened", metadata: { announcement_id: ANN_A } },
    { student_id: "s9", event_type: "announcement.viewed", metadata: { announcement_id: "other" } },
  ];
  const counts = await countAnnouncementViews(db as never, [ANN_A, ANN_B]);
  assert.equal(counts[ANN_A], 2); // s1 twice + s2 once -> 2 distinct
  assert.equal(counts[ANN_B], 1);
});

test("countAnnouncementViews returns 0 for announcements nobody viewed", async () => {
  const db = new FakeDb();
  const counts = await countAnnouncementViews(db as never, [ANN_A]);
  assert.equal(counts[ANN_A], 0);
});

test("countAnnouncementViews returns 0 when the query fails", async () => {
  const failing = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        then(resolve: (v: { data: null; error: Error }) => void) {
          resolve({ data: null, error: new Error("db down") });
        },
      };
    },
  } as never;
  const counts = await countAnnouncementViews(failing, [ANN_A]);
  assert.equal(counts[ANN_A], 0);
});
