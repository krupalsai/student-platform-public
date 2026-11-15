// Closing a batch rolls its unpaid students into the college's next batch (2026-10-15/16).
//
// The owner's rule: when a batch closes nobody is left behind in it, paid stays paid,
// unpaid stays unpaid, and re-closing or a double tap must not duplicate anyone.
//
// This runs the REAL src/lib/services/batches.ts and petitions.ts against an in-memory
// database that behaves like PostgREST where it matters: filters, returned rows, the
// "one live batch per college" and unique-slug indexes, and a hook to land a payment (or a
// failed read) in the middle of a move. Only audit, the WhatsApp sender, the export token
// and the waiting-list sender are stubbed, so we can see exactly what each would have done.
//
// Run: node scripts/test-batch-rollover.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");

const read = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.error("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); }
};

// ---- stubs for the four side effects --------------------------------------------------------
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollover-stubs-"));
const stub = (name, body) => { const f = path.join(stubDir, name); fs.writeFileSync(f, body); return f; };
const alias = {
  "@/lib/audit": stub("audit.cjs", "exports.audit = async (...a) => { globalThis.__rollover.audits.push(a); };"),
  "@/lib/whatsapp/client": stub("wa.cjs", "exports.sendWhatsAppDocument = async (...a) => { globalThis.__rollover.docs.push(a); };"),
  "@/lib/export-token": stub("tok.cjs", 'exports.issueExportToken = async () => "tok";'),
  "@/lib/services/waitlist-processing": stub("wl.cjs", "exports.processWaitlistForCollege = async (_db, c) => { globalThis.__rollover.waitlists.push(c); return { processed: 0, failed: 0 }; };"),
  "@": path.resolve(__dirname, "../src"),
};
const jiti = require("jiti")(__filename, { alias, interopDefault: true });
const svc = jiti("../src/lib/services/batches.ts");
const petitions = jiti("../src/lib/services/petitions.ts");
const reset = () => { globalThis.__rollover = { audits: [], docs: [], waitlists: [] }; };
const auditsOf = (action) => globalThis.__rollover.audits.filter((a) => a[0] === action);

// ---- an in-memory PostgREST ----------------------------------------------------------------
let uid = 0;
const newId = (p) => `${p}-${++uid}`;

function makeDb(seed) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const db = {
    tables,
    maxInList: 0,
    /** every update that matched rows: which table and which ids were written */
    writes: [],
    /** called right before a query touches its table; may mutate tables or return { error } */
    before: null,
    /** random extra awaits so two concurrent flows interleave differently on each run */
    jitter: null,
    from: (table) => new Query(db, table),
  };
  return db;
}

const LIVE = ["active", "pending_setup"];
class Query {
  constructor(db, table) {
    this.db = db; this.table = table; this.op = "select"; this.filters = []; this.specs = [];
    this.values = null; this.opts = {}; this.returning = false; this.cols = "*"; this.mode = null; this.limitN = null;
  }
  select(cols, opts) { if (this.op === "select") { this.cols = cols ?? "*"; this.opts = opts ?? {}; } else { this.returning = true; this.cols = cols ?? "*"; } return this; }
  insert(v) { this.op = "insert"; this.values = v; return this; }
  update(v, opts) { this.op = "update"; this.values = v; this.opts = opts ?? {}; return this; }
  upsert(v, opts) { this.op = "upsert"; this.values = v; this.opts = opts ?? {}; return this; }
  _f(kind, col, val, fn) { this.specs.push([kind, col, val]); this.filters.push(fn); return this; }
  eq(c, v) { return this._f("eq", c, v, (r) => r[c] === v); }
  neq(c, v) { return this._f("neq", c, v, (r) => r[c] !== v); }
  in(c, list) { this.db.maxInList = Math.max(this.db.maxInList, list.length); return this._f("in", c, list, (r) => list.includes(r[c])); }
  is(c, v) { return this._f("is", c, v, (r) => (r[c] ?? null) === v); }
  ilike(c, pat) { const re = new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i"); return this._f("ilike", c, pat, (r) => re.test(String(r[c] ?? ""))); }
  order() { return this; }
  limit(n) { this.limitN = n; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  single() { this.mode = "one"; return this; }
  then(res, rej) { return this.exec().then(res, rej); }

  _pick(row) {
    if (this.cols === "*" || this.cols == null) return { ...row };
    const out = {};
    for (const c of String(this.cols).split(",").map((s) => s.trim()).filter(Boolean)) out[c] = row[c];
    return out;
  }
  _shape(rows) {
    if (this.mode === "maybe") {
      if (rows.length > 1) return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
      return { data: rows[0] ? this._pick(rows[0]) : null, error: null };
    }
    if (this.mode === "one") {
      if (rows.length !== 1) return { data: null, error: { message: "expected one row", code: "PGRST116" } };
      return { data: this._pick(rows[0]), error: null };
    }
    return { data: rows.map((r) => this._pick(r)), error: null, count: rows.length };
  }

  async exec() {
    const db = this.db;
    if (db.jitter) { const n = db.jitter(); for (let i = 0; i < n; i++) await Promise.resolve(); }
    else await Promise.resolve();
    const injected = db.before ? await db.before(this) : null;
    if (injected && injected.error) return { data: null, error: injected.error, count: null };

    const rows = db.tables[this.table] ?? (db.tables[this.table] = []);
    const matches = () => rows.filter((r) => this.filters.every((f) => f(r)));

    if (this.op === "select") {
      let out = matches();
      if (this.limitN != null) out = out.slice(0, this.limitN);
      return this._shape(out);
    }
    if (this.op === "update") {
      const hit = matches();
      for (const r of hit) Object.assign(r, this.values);
      db.writes.push({ table: this.table, ids: hit.map((r) => r.id), values: this.values });
      if (!this.returning) return { data: null, error: null, count: this.opts.count === "exact" ? hit.length : null };
      return this._shape(hit);
    }
    if (this.op === "upsert") {
      const key = this.opts.onConflict;
      const exists = rows.find((r) => r[key] === this.values[key]);
      if (exists) return { data: null, error: null };
      rows.push({ id: newId(this.table), ...this.values });
      return { data: null, error: null };
    }
    // insert, with the two unique indexes batches really has
    const row = { id: newId(this.table), created_at: new Date().toISOString(), ...this.values };
    if (this.table === "batches") {
      if (rows.some((r) => r.slug === row.slug)) return { data: null, error: { code: "23505", message: "batches_slug_unique" } };
      if (LIVE.includes(row.status) && rows.some((r) => r.college === row.college && LIVE.includes(r.status))) {
        return { data: null, error: { code: "23505", message: "batches_one_live_per_college" } };
      }
    }
    rows.push(row);
    return this.returning ? this._shape([row]) : { data: null, error: null };
  }
}

// ---- seeds ----------------------------------------------------------------------------------
const PREV = { fee_amount: "1100.00", batch_limit: 60, upi_id: "test-payee-1", upi_name: "Fee Payment", extra_fee_amount: null, extra_fee_label: null, extra_fee_note: null, extra_fee_starts_at: null };
const batch = (id, name, college, status, extra = {}) => ({ id, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), college, status, ...PREV, ...extra });
const prof = (id, batch_id, complete = true, extra = {}) => ({ id, batch_id, is_profile_complete: complete, role: "student", ...extra });
const pay = (id, student_id, status, batch_id = "b1") => ({ id, student_id, status, batch_id });
const pet = (student_id, batch_id) => ({ id: `pet-${student_id}`, student_id, batch_id, status: "draft" });

function seedEnd() {
  return makeDb({
    batches: [batch("b1", "GNITC Batch 1", "GNITC", "active"), batch("g1", "GNIT Batch 1", "GNIT", "active")],
    profiles: [
      prof("p1", "b1"), prof("p2", "b1"),                 // paid
      prof("p3", "b1"), prof("p4", "b1"),                 // registered, unpaid
      prof("p5", "b1", false),                            // unfinished registration
      prof("gx", "g1"),                                   // another college's unpaid student
    ],
    payments: [
      pay("y1", "p1", "approved"),
      pay("y2", "p2", "approved"), pay("y3", "p2", "pg_failed"),   // paid, then a later failed attempt
      pay("y4", "p3", "pg_failed"),                       // unpaid: only a failed attempt
      pay("y5", "gx", "pg_failed", "g1"),
    ],
    petitions: [pet("p1", "b1"), pet("p2", "b1"), pet("p3", "b1"), pet("p4", "b1"), pet("gx", "g1")],
    admins: [{ phone: "9000000001", active: true }],
  });
}
const where = (db, id) => db.tables.profiles.find((p) => p.id === id).batch_id;
const petIn = (db, id) => db.tables.petitions.find((p) => p.student_id === id)?.batch_id;
const batchesOf = (db, college) => db.tables.batches.filter((b) => b.college === college);

(async () => {
  // ===== 1. End Batch: unpaid roll over, paid stay, nothing else is touched ========================
  {
    reset();
    const db = seedEnd();
    const r = await svc.endBatchAndCreateNext(db, "b1", "admin-1");
    check("1 end succeeds", r.ok === true, r);
    const next = batchesOf(db, "GNITC").find((b) => b.id !== "b1");
    check("1 the old batch is closed", db.tables.batches.find((b) => b.id === "b1").status === "closed");
    check("1 exactly one new batch, named as the next in sequence, Active", batchesOf(db, "GNITC").length === 2 && next.name === "GNITC Batch 2" && next.status === "active", batchesOf(db, "GNITC"));
    check("1 fee, limit and payee carry over", Number(next.fee_amount) === 1100 && next.batch_limit === 60 && next.upi_id === "test-payee-1");
    check("1 result names the new batch and says the fee is set", r.newBatch.id === next.id && r.newBatch.name === "GNITC Batch 2" && r.newBatch.fee_amount === 1100, r.newBatch);
    check("1 paid students stay in the closed batch", where(db, "p1") === "b1" && where(db, "p2") === "b1");
    check("1 paid students' profiles are never even written to (the put-back is a second line, not the first)",
      !db.writes.some((w) => w.table === "profiles" && w.ids.some((id) => id === "p1" || id === "p2")), db.writes.filter((w) => w.table === "profiles"));
    check("1 …nor their petitions", !db.writes.some((w) => w.table === "petitions" && w.ids.some((id) => id === "pet-p1" || id === "pet-p2")));
    check("1 a paid student with a LATER failed attempt still counts as paid", where(db, "p2") === "b1");
    check("1 registered-but-unpaid students move", where(db, "p3") === next.id && where(db, "p4") === next.id);
    check("1 an unfinished registration is not left in the closed batch either", where(db, "p5") === next.id);
    check("1 another college is untouched", where(db, "gx") === "g1" && batchesOf(db, "GNIT").length === 1);
    check("1 moved count is exact", r.movedStudents === 3, r.movedStudents);
    check("1 each moved student's petition follows them", petIn(db, "p3") === next.id && petIn(db, "p4") === next.id);
    check("1 paid students' petitions stay with the closed batch", petIn(db, "p1") === "b1" && petIn(db, "p2") === "b1");
    check("1 no student got a second petition", db.tables.petitions.length === 5);
    check("1 statuses are not rewritten", db.tables.petitions.every((p) => p.status === "draft"));
    check("1 payments are untouched", db.tables.payments.length === 5 && db.tables.payments.find((p) => p.id === "y1").status === "approved");
    const ended = auditsOf("batch.ended"), moved = auditsOf("batch.students_transferred");
    check("1 one 'ended' audit and one 'transferred' audit", ended.length === 1 && moved.length === 1);
    const meta = moved[0][3];
    check("1 the audit names exactly who moved", meta.moved_unpaid === 3 && meta.student_ids.slice().sort().join() === "p3,p4,p5" && meta.to_batch === next.id && meta.next_batch_created === true, meta);
    check("1 …and how many petition records followed", meta.petitions_repointed === 2, meta.petitions_repointed);
    check("1 the court-exhibit ZIP goes to the admins once, from the closed batch", globalThis.__rollover.docs.length === 1);
    check("1 the college's waiting list is told the new batch is open", globalThis.__rollover.waitlists.join() === "GNITC");
    const lines = svc.endBatchSummaryLines(r).join(" | ");
    check("1 summary says closed / active / moved / fee carried over", /GNITC Batch 1 is now closed/.test(lines) && /GNITC Batch 2 is the Active batch/.test(lines) && /3 unpaid students moved to GNITC Batch 2\. Paid students stay in GNITC Batch 1/.test(lines) && /Fee carried over: ₹1,100/.test(lines), lines);
    check("1 the WhatsApp summary can bold the names", svc.endBatchSummaryLines(r, (s) => `*${s}*`)[0] === "*GNITC Batch 1* is now closed.");

    // ===== 2. tap End again once it has finished: nothing is duplicated =========================
    const again = await svc.endBatchAndCreateNext(db, "b1", "admin-1");
    check("2 a second End after the first finished is harmless", again.ok === true && again.repaired === true && again.movedStudents === 0, again);
    check("2 it points at the SAME next batch", again.newBatch.id === next.id);
    check("2 no second next batch", batchesOf(db, "GNITC").length === 2);
    check("2 no second 'ended' audit, no second transfer audit", auditsOf("batch.ended").length === 1 && auditsOf("batch.students_transferred").length === 1);
    check("2 no second ZIP, no second waiting-list run", globalThis.__rollover.docs.length === 1 && globalThis.__rollover.waitlists.length === 1);
    check("2 nobody moved twice", where(db, "p3") === next.id && where(db, "p1") === "b1" && db.tables.petitions.length === 5);
    check("2 summary of a repeat says nobody was left to move", /already closed/.test(svc.endBatchSummaryLines(again)[0]) && /Nobody was left to move/.test(svc.endBatchSummaryLines(again)[2]));
  }

  // ===== 3. two taps at once, over many different interleavings ===============================
  {
    let bad = 0, ranBoth = 0, lostRace = 0, healed = 0;
    let seedN = 12345;
    const rand = () => { seedN = (seedN * 1664525 + 1013904223) % 4294967296; return seedN / 4294967296; };
    for (let i = 0; i < 150; i++) {
      reset();
      const db = seedEnd();
      db.jitter = () => (rand() < 0.3 ? 0 : Math.floor(rand() * 6));
      const [a, b] = await Promise.all([
        svc.endBatchAndCreateNext(db, "b1", "admin-1"),
        svc.endBatchAndCreateNext(db, "b1", "admin-1"),
      ]);
      const oks = [a, b].filter((x) => x.ok);
      const next = batchesOf(db, "GNITC").find((x) => x.id !== "b1");
      const movedSum = oks.reduce((n, x) => n + x.movedStudents, 0);
      const good =
        oks.length >= 1 &&
        batchesOf(db, "GNITC").length === 2 &&
        batchesOf(db, "GNITC").filter((x) => LIVE.includes(x.status)).length === 1 &&
        ["p3", "p4", "p5"].every((id) => where(db, id) === next.id) &&
        ["p1", "p2"].every((id) => where(db, id) === "b1") &&
        movedSum === 3 &&
        auditsOf("batch.ended").length === 1 &&
        globalThis.__rollover.docs.length === 1 &&
        db.tables.petitions.length === 5 &&
        ["p3", "p4"].every((id) => petIn(db, id) === next.id) &&
        where(db, "gx") === "g1";
      if (!good) { bad++; if (bad === 1) console.error("   first bad interleaving:", JSON.stringify({ a, b, batches: batchesOf(db, "GNITC"), movedSum, audits: globalThis.__rollover.audits.map((x) => x[0]) })); }
      if (oks.length === 2) ranBoth++; else if ([a, b].some((x) => !x.ok && x.reason === "not_active")) lostRace++;
      if (oks.some((x) => x.repaired)) healed++;
    }
    check("3 150 double taps: never a second batch, never a duplicated or stranded student", bad === 0, { bad });
    check("3 the run really exercised different interleavings", lostRace + healed > 0 && ranBoth + lostRace > 0, { ranBoth, lostRace, healed });
  }

  // ===== 4. a payment lands while the move is running: paid stays paid ========================
  {
    reset();
    const db = seedEnd();
    let fired = false;
    db.before = async (q) => {
      // the instant before students are moved, p3's payment is approved by the gateway
      if (!fired && q.table === "profiles" && q.op === "update") {
        fired = true;
        db.tables.payments.push(pay("late", "p3", "approved"));
      }
    };
    const r = await svc.endBatchAndCreateNext(db, "b1", "admin-1");
    const next = batchesOf(db, "GNITC").find((b) => b.id !== "b1");
    check("4 the late payer is put back in the batch they paid into", fired && where(db, "p3") === "b1", where(db, "p3"));
    check("4 their petition never leaves it", petIn(db, "p3") === "b1");
    check("4 the others still moved, and the count excludes the late payer", where(db, "p4") === next.id && where(db, "p5") === next.id && r.movedStudents === 2, r.movedStudents);
    check("4 the audit lists only who really moved", auditsOf("batch.students_transferred")[0][3].student_ids.slice().sort().join() === "p4,p5");
  }

  // ===== 5. a failed read must never be taken for "nobody has paid" ============================
  {
    reset();
    const db = seedEnd();
    db.before = async (q) => (q.table === "payments" ? { error: { message: "connection reset" } } : null);
    const r = await svc.endBatchAndCreateNext(db, "b1", "admin-1");
    check("5 a failed payments read ends as transfer_failed, not as a silent success", r.ok === false && r.reason === "transfer_failed", r);
    check("5 NOBODY moved — paid students above all", ["p1", "p2", "p3", "p4", "p5"].every((id) => where(db, id) === "b1"));
    check("5 the batch is closed and the next one exists (so the failure message is true)", db.tables.batches.find((b) => b.id === "b1").status === "closed" && batchesOf(db, "GNITC").length === 2);
    const msg = svc.describeEndBatchFailure(r.reason);
    check("5 the admin is told the batch IS closed and how to finish", msg.batchClosed === true && /Move unpaid to next batch/.test(msg.message));
    db.before = null;
    const fixed = await svc.endBatchAndCreateNext(db, "b1", "admin-1");
    const next = batchesOf(db, "GNITC").find((b) => b.id !== "b1");
    check("5 finishing it later moves the three unpaid and still leaves the paid", fixed.ok && fixed.movedStudents === 3 && where(db, "p3") === next.id && where(db, "p1") === "b1", fixed);
  }

  // ===== 6. a big batch: no request carries more than 200 ids ==================================
  {
    reset();
    const members = [prof("pay-1", "b1"), prof("pay-2", "b1")];
    const payments = [pay("a1", "pay-1", "approved"), pay("a2", "pay-2", "approved")];
    const petRows = [pet("pay-1", "b1"), pet("pay-2", "b1")];
    for (let i = 0; i < 450; i++) { members.push(prof(`u${i}`, "b1", i % 3 !== 0)); petRows.push(pet(`u${i}`, "b1")); }
    const db = makeDb({ batches: [batch("b1", "GNITC Batch 1", "GNITC", "active")], profiles: members, payments, petitions: petRows, admins: [] });
    const r = await svc.endBatchAndCreateNext(db, "b1", null);
    const next = batchesOf(db, "GNITC").find((b) => b.id !== "b1");
    check("6 all 450 unpaid moved", r.ok && r.movedStudents === 450 && members.slice(2).every((m) => where(db, m.id) === next.id), r.movedStudents);
    check("6 both paid students stayed", where(db, "pay-1") === "b1" && where(db, "pay-2") === "b1");
    check("6 their petitions all followed", petRows.slice(2).every((p) => petIn(db, p.student_id) === next.id));
    check("6 no id list longer than 200 was ever sent", db.maxInList <= 200, db.maxInList);
    check("6 the audit keeps the count exact", auditsOf("batch.students_transferred")[0][3].moved_unpaid === 450);
  }

  // ===== 7. the repair button: the college already has a live batch ============================
  {
    reset();
    const db = makeDb({
      batches: [batch("b1", "GNITC Batch 1", "GNITC", "closed"), batch("b2", "GNITC Batch 2", "GNITC", "active", { fee_amount: null })],
      profiles: [prof("p1", "b1"), prof("p3", "b1"), prof("p4", "b1", false), prof("q1", "b2")],
      payments: [pay("y1", "p1", "approved")],
      petitions: [pet("p1", "b1"), pet("p3", "b1"), pet("q1", "b2")],
    });
    const row = db.tables.batches[0];
    const out = await svc.rollOverClosedBatch(db, { ...row, id: "b1" }, "admin-1", { repaired: true });
    check("7 repair moves the unpaid into the batch that is already live", out.moved === 2 && out.target.id === "b2" && where(db, "p3") === "b2" && where(db, "p4") === "b2");
    check("7 the paid student stays", where(db, "p1") === "b1" && petIn(db, "p1") === "b1");
    check("7 it did not create another batch", db.tables.batches.length === 2 && out.target.created === false);
    check("7 it did not message the waiting list (no batch was created)", globalThis.__rollover.waitlists.length === 0);
    check("7 it recorded the repair", auditsOf("batch.students_transferred")[0][3].repaired === true);
    check("7 a batch that has no fee yet is reported as such", /No fee is set on GNITC Batch 2/.test(svc.endBatchSummaryLines({ ok: true, newBatch: { id: "b2", name: "GNITC Batch 2", slug: "", college: "GNITC", fee_amount: null }, endedName: "GNITC Batch 1", movedStudents: 2 }).join(" ")));
    const again = await svc.rollOverClosedBatch(db, { ...row, id: "b1" }, "admin-1", { repaired: true });
    check("7 pressing it again moves nobody and records nothing new", again.moved === 0 && auditsOf("batch.students_transferred").length === 1);
  }

  // ===== 8. a closed batch with NO live successor: the repair creates it ======================
  {
    reset();
    const db = makeDb({
      batches: [batch("b1", "GNITC Batch 1", "GNITC", "closed")],
      profiles: [prof("p1", "b1"), prof("p3", "b1")],
      payments: [pay("y1", "p1", "approved")],
      petitions: [pet("p1", "b1"), pet("p3", "b1")],
    });
    const out = await svc.rollOverClosedBatch(db, { ...db.tables.batches[0] }, null, { repaired: true });
    check("8 the next batch is created and the unpaid student moved into it", out.target.created && out.target.name === "GNITC Batch 2" && where(db, "p3") === out.target.id);
    check("8 a created batch tells the waiting list", globalThis.__rollover.waitlists.join() === "GNITC");
    check("8 without an admin the audit says 'system'", auditsOf("batch.students_transferred")[0][5] === "system");
  }

  // ===== 9. a student whose payment is in review is moved — and put back when it is approved ====
  {
    reset();
    const db = makeDb({
      batches: [batch("b1", "GNITC Batch 1", "GNITC", "active")],
      profiles: [prof("p6", "b1")],
      payments: [pay("s1", "p6", "submitted", "b1")],
      petitions: [pet("p6", "b1")],
    });
    const r = await svc.endBatchAndCreateNext(db, "b1", null);
    const next = batchesOf(db, "GNITC").find((b) => b.id !== "b1");
    check("9 a student with a payment still in review counts as unpaid", r.movedStudents === 1 && where(db, "p6") === next.id && petIn(db, "p6") === next.id);
    // approval (auto-approve.ts) pulls the student back to the batch the payment was made for, then
    // createPetitionForStudent runs — the petition must follow, not stay behind
    db.tables.profiles.find((p) => p.id === "p6").batch_id = "b1";
    await petitions.createPetitionForStudent(db, "p6", "b1");
    check("9 …and the petition follows them back", petIn(db, "p6") === "b1" && db.tables.petitions.length === 1);
  }

  // ===== 10. petitions: created once, re-pointed (never reset) when the batch differs ============
  {
    const db = makeDb({ petitions: [{ id: "x", student_id: "s", batch_id: "old", status: "pending_review", review_notes: "keep me" }] });
    await petitions.createPetitionForStudent(db, "s", "new");
    const row = db.tables.petitions[0];
    check("10 re-pointed to the batch the student is in", row.batch_id === "new" && db.tables.petitions.length === 1);
    check("10 status and notes untouched", row.status === "pending_review" && row.review_notes === "keep me");
    await petitions.createPetitionForStudent(db, "t", "new");
    check("10 a student with none gets one", db.tables.petitions.filter((p) => p.student_id === "t").length === 1);
    await petitions.createPetitionForStudent(db, "t", "new");
    check("10 calling again never makes a second", db.tables.petitions.filter((p) => p.student_id === "t").length === 1);
    const moved = await petitions.movePetitionsToBatch(db, ["s", "t"], "gone", "other");
    check("10 movePetitionsToBatch only touches records still in the old batch", moved === 0 && db.tables.petitions.every((p) => p.batch_id === "new"));
  }

  // ===== 10b. two closes race for the next batch: the loser must pick up the winner's, not fail ====
  {
    reset();
    const db = makeDb({
      batches: [batch("b1", "GNITC Batch 1", "GNITC", "closed")],
      profiles: [prof("p3", "b1")],
      payments: [],
      petitions: [pet("p3", "b1")],
    });
    let raced = false;
    db.before = async (q) => {
      // the instant before OUR insert, another request creates the college's next batch
      if (!raced && q.table === "batches" && q.op === "insert") {
        raced = true;
        db.tables.batches.push({ id: "winner", ...batch("winner", "GNITC Batch 2", "GNITC", "active", { fee_amount: "900.00" }) });
      }
    };
    const t = await svc.resolveTransferTarget(db, "GNITC", db.tables.batches[0]);
    check("10b the loser of the race uses the winner's batch", raced && t.id === "winner" && t.created === false, t);
    check("10b …reads its fee as a number", t.fee_amount === 900);
    check("10b …and there is still exactly one live batch", db.tables.batches.filter((b) => LIVE.includes(b.status)).length === 1);
    const out = await svc.rollOverClosedBatch(db, { ...db.tables.batches[0] }, null, { repaired: true });
    check("10b rolling over after the race moves the student into the winner's batch, once", out.target.id === "winner" && where(db, "p3") === "winner" && petIn(db, "p3") === "winner");
    check("10b the loser does not message the waiting list (the winner's run does)", globalThis.__rollover.waitlists.length === 0);
  }

  // ===== 10c. students already moved by the first version: pressing repair again heals them ========
  {
    reset();
    const db = makeDb({
      batches: [batch("b1", "GNITC Batch 1", "GNITC", "closed"), batch("b2", "GNITC Batch 2", "GNITC", "active")],
      // p3/p4 were moved to b2 but their petition records were left behind in b1; p1 paid and stays in b1
      profiles: [prof("p1", "b1"), prof("p3", "b2"), prof("p4", "b2"), prof("q9", "b2")],
      payments: [pay("y1", "p1", "approved")],
      petitions: [pet("p1", "b1"), pet("p3", "b1"), pet("p4", "b1"), pet("q9", "b2")],
    });
    const row = { ...db.tables.batches[0] };
    const out = await svc.rollOverClosedBatch(db, row, "admin-1", { repaired: true });
    check("10c nobody left to move, but the stale petition records are brought along", out.moved === 0 && petIn(db, "p3") === "b2" && petIn(db, "p4") === "b2", out);
    check("10c the paid student's record stays with the closed batch", petIn(db, "p1") === "b1");
    check("10c a record already in the right batch is untouched", petIn(db, "q9") === "b2");
    const heal = auditsOf("batch.students_transferred");
    check("10c the repair is recorded because it changed something", heal.length === 1 && heal[0][3].petitions_repointed === 2 && heal[0][3].moved_unpaid === 0, heal.map((a) => a[3]));
    await svc.rollOverClosedBatch(db, row, "admin-1", { repaired: true });
    check("10c pressing it again changes and records nothing", auditsOf("batch.students_transferred").length === 1);
  }

  // ===== 11. what each surface says when something fails ========================================
  {
    check("11 not_active keeps the old wording", svc.describeEndBatchFailure("not_active").message === "Only the currently Active batch can be ended." && svc.describeEndBatchFailure("not_active").batchClosed === false);
    check("11 not_found", svc.describeEndBatchFailure("not_found").batchClosed === false);
    check("11 create_failed says the batch is closed", svc.describeEndBatchFailure("create_failed").batchClosed === true && /now closed/.test(svc.describeEndBatchFailure("create_failed").message));
    const noFee = svc.endBatchSummaryLines({ ok: true, newBatch: { id: "n", name: "GNIT Batch 3", slug: "", college: "GNIT", fee_amount: null }, endedName: "GNIT Batch 2", movedStudents: 1 }).join(" ");
    check("11 one student is not '1 students'", /1 unpaid student moved/.test(noFee) && !/students moved/.test(noFee));
    check("11 no fee carried over is said plainly", /No fee is set on GNIT Batch 3 yet/.test(noFee));
  }

  // ===== 12. the code paths all share the one function ==========================================
  {
    const batches = read("src/lib/services/batches.ts");
    const patch = read("src/app/api/admin/batches/[id]/route.ts");
    const repair = read("src/app/api/admin/batches/[id]/repair-transfer/route.ts");
    const end = read("src/app/api/admin/batches/[id]/end/route.ts");
    const admin = read("src/lib/whatsapp/admin.ts");
    const menu = read("src/lib/whatsapp/admin-menu.ts");
    const copilot = read("src/lib/admin-copilot-agent.ts");
    const flow = read("src/lib/whatsapp/admin-batch-flow.ts");
    check("12 closing by status edit uses the shared roll-over", /rollOverClosedBatch\(/.test(patch) && !/transferUnpaidStudents\(/.test(patch));
    check("12 the repair button uses it too", /rollOverClosedBatch\(/.test(repair) && !/transferUnpaidStudents\(/.test(repair));
    check("12 End Batch (website) goes through endBatchAndCreateNext", /endBatchAndCreateNext\(/.test(end));
    check("12 End Batch calls the roll-over in both the fresh and the repeat branch", (batches.match(/rollOverClosedBatch\(db, batch as ClosedBatchRow/g) || []).length === 2);
    const transferFn = batches.slice(batches.indexOf("export async function transferUnpaidStudents"), batches.indexOf("export class RollOverError"));
    check("12 who moved is read from returned rows, not count", /\.select\("id"\);\s*\n\s*if \(moveError\)/.test(transferFn) && !/count:/.test(transferFn.replace(/\/\*[\s\S]*?\*\//g, "")));
    check("12 a failed read is never turned into 'nobody paid'", /if \(error\) throw error;[\s\S]{0,200}paid\.add/.test(batches));
    check("12 the End route no longer claims 'Nothing was changed' after the batch is closed", !/Nothing was changed/.test(end));
    check("12 nothing still says the next batch has no fee when it carries one", !/Its registration fee is \*not set yet\*/.test(admin) && !/opens with \*no fee set\*/.test(menu) && !/Set its fee before accepting payments/.test(copilot));
    check("12 the confirm prompts promise what really happens", /Students who have not paid move to the next batch/.test(menu) && /move every student who has not paid into it/.test(copilot));
    check("12 Skip on the fee question does not lie when the fee carried over", /keeps its fee of/.test(flow));
    check("12 the waiting list is processed inside the roll-over, once per created batch", /if \(target\.created\)[\s\S]{0,300}processWaitlistForCollege/.test(batches));
    check("12 the Copilot no longer processes the waiting list a second time for End", !/case "end_batch":\{const r=await endBatchAndCreateNext[^}]*processWaitlistForCollege/.test(copilot));
    check("12 the court-order recipients still come from petitions.batch_id (so moving them matters)", /\.eq\("batch_id", batch\.id\)/.test(read("src/lib/services/court-order-watch.ts")));
  }

  console.log(`\nbatch roll-over: ${pass} passed, ${fail} failed`);
  fs.rmSync(stubDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(stubDir, { recursive: true, force: true }); process.exit(1); });
