/**
 * Fake-DB tests for addCollege() (src/lib/services/colleges.ts).
 *
 * The Admin Colleges page and the Copilot "create a new college" command
 * both go through addCollege. These tests drive the real function against
 * an in-memory fake Supabase client — no network, no real rows.
 *
 * Only the query shapes addCollege actually uses are faked: select with
 * .or()/.eq()/.maybeSingle(), update().eq(), insert().
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addCollege } from "../src/lib/services/colleges.ts";

type Row = Record<string, unknown>;

class FakeQuery {
  private rows: Row[];
  private filters: ((r: Row) => boolean)[] = [];
  private pendingInsert: Row | null = null;
  private pendingUpdate: Row | null = null;

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

  or(expr: string): this {
    // "id.ilike.X,name.ilike.Y" — exact case-insensitive match on either side.
    const parts = expr.split(",").map((p) => {
      const [col, , value] = p.split(".");
      return { col, value: String(value ?? "").toLowerCase() };
    });
    this.filters.push((r) =>
      parts.some((p) => String(r[p.col] ?? "").toLowerCase() === p.value),
    );
    return this;
  }

  update(patch: Row): this {
    this.pendingUpdate = patch;
    return this;
  }

  // addCollege awaits the bare update().eq() chain (real Supabase builders
  // are thenable), so apply the pending update when awaited.
  then(resolve: (v: { data: null; error: null }) => void): void {
    if (this.pendingUpdate) {
      for (const r of this.rows) {
        if (this.filters.every((f) => f(r))) Object.assign(r, this.pendingUpdate);
      }
    }
    resolve({ data: null, error: null });
  }

  insert(row: Row): { error: null } {
    this.rows.push({ ...row });
    return { error: null };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.pendingUpdate) {
      for (const r of this.rows) {
        if (this.filters.every((f) => f(r))) Object.assign(r, this.pendingUpdate);
      }
      return { data: null, error: null };
    }
    const found = this.rows.find((r) => this.filters.every((f) => f(r))) ?? null;
    return { data: found, error: null };
  }
}

class FakeDb {
  rows: Row[];
  inserted: Row[] = [];
  constructor(rows: Row[]) {
    this.rows = rows;
  }
  from() {
    const q = new FakeQuery(this.rows);
    const origInsert = q.insert.bind(q);
    q.insert = (row: Row) => {
      this.inserted.push({ ...row });
      return origInsert(row);
    };
    return q;
  }
}

const asDb = (db: FakeDb) => db as never;

test("creates a new acronym college using the name as its id", async () => {
  const db = new FakeDb([
    { id: "GNIT", name: "GNIT", active: true, institution_type: "engineering" },
  ]);
  const r = await addCollege(asDb(db), "BIET");
  assert.deepEqual(r, { ok: true, id: "BIET", reactivated: false });
  assert.equal(db.inserted.length, 1);
  assert.equal(db.inserted[0].id, "BIET");
  assert.equal(db.inserted[0].name, "BIET");
  assert.equal(db.inserted[0].active, true);
  assert.equal(db.inserted[0].institution_type, "engineering");
  assert.deepEqual(db.inserted[0].search_aliases, ["BIET"]);
});

test("a full name gets a slug id unless a short code is given", async () => {
  const db = new FakeDb([]);
  const slugged = await addCollege(asDb(db), "Sreenidhi Institute of Science and Technology");
  assert.deepEqual(slugged, { ok: true, id: "SREENIDHI-INSTITUTE-OF-SCIENCE-AND-TECHN", reactivated: false });

  const db2 = new FakeDb([]);
  const coded = await addCollege(asDb(db2), "Sreenidhi Institute of Science and Technology", "snist");
  assert.deepEqual(coded, { ok: true, id: "SNIST", reactivated: false });
  assert.deepEqual(db.inserted[0].search_aliases, ["Sreenidhi Institute of Science and Technology", "SREENIDHI-INSTITUTE-OF-SCIENCE-AND-TECHN"]);
  assert.deepEqual(db2.inserted[0].search_aliases, ["Sreenidhi Institute of Science and Technology", "SNIST"]);
});

test("the insert uses only columns that exist on the live colleges table", async () => {
  // Live incident 11 Nov 2026: addCollege inserted college_code (and
  // normalized_name), which migration 0074 added but production never
  // applied — PostgREST rejected every ADD COLLEGE with "Could not find
  // the 'college_code' column of 'colleges' in the schema cache"
  // (ADD COLLEGE CMR TECHNICAL CAMPUS failed twice). The live table has
  // exactly: id, name, active, created_at, institution_type,
  // search_aliases (created_at is defaulted server-side).
  const db = new FakeDb([]);
  const r = await addCollege(asDb(db), "CMR TECHNICAL CAMPUS", "CMR");
  assert.deepEqual(r, { ok: true, id: "CMR", reactivated: false });
  assert.equal(db.inserted.length, 1);
  assert.deepEqual(Object.keys(db.inserted[0]).sort(), [
    "active",
    "id",
    "institution_type",
    "name",
    "search_aliases",
  ]);
  assert.deepEqual(db.inserted[0].search_aliases, ["CMR TECHNICAL CAMPUS", "CMR"]);
});

test("re-activates an inactive college instead of adding it twice", async () => {
  const db = new FakeDb([
    { id: "SNIST", name: "Sreenidhi Institute of Science and Technology", active: false, institution_type: "engineering" },
  ]);
  const r = await addCollege(asDb(db), "Sreenidhi Institute of Science and Technology");
  assert.deepEqual(r, { ok: true, id: "SNIST", reactivated: true });
  assert.equal(db.inserted.length, 0);
  assert.equal(db.rows[0].active, true);
});

test("an already-active college is rejected in plain words", async () => {
  const db = new FakeDb([{ id: "GNIT", name: "GNIT", active: true, institution_type: "engineering" }]);
  assert.deepEqual(await addCollege(asDb(db), "GNIT"), {
    ok: false,
    reason: "GNIT is already active.",
  });
  assert.equal(db.inserted.length, 0);
});

test("a short code already used by another college is rejected", async () => {
  const db = new FakeDb([{ id: "GNIT", name: "GNIT", active: true, institution_type: "engineering" }]);
  assert.deepEqual(await addCollege(asDb(db), "New College", "GNIT"), {
    ok: false,
    reason: "GNIT is already used by GNIT. Pick a different short code.",
  });
  assert.equal(db.inserted.length, 0);
});

test("bad names and codes are rejected before any database write", async () => {
  const db = new FakeDb([]);
  assert.deepEqual(await addCollege(asDb(db), "x"), { ok: false, reason: "That name is too short." });
  assert.deepEqual(await addCollege(asDb(db), "a".repeat(121)), { ok: false, reason: "That name is too long." });
  assert.deepEqual(await addCollege(asDb(db), "New College", "N"), {
    ok: false,
    reason: "The short code should be 2–10 letters, like GNIT.",
  });
  assert.deepEqual(await addCollege(asDb(db), "New College", "SNIST123"), {
    ok: false,
    reason: "The short code should be 2–10 letters, like GNIT.",
  });
  assert.equal(db.inserted.length, 0);
});
