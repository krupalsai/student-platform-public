import { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { sendWhatsAppDocument } from "@/lib/whatsapp/client";
import { issueExportToken } from "@/lib/export-token";
import { movePetitionsToBatch } from "@/lib/services/petitions";

/**
 * Shared batch-capacity service.
 *
 * These functions are the single source of truth for "what's the current
 * active batch", "how many seats are left", and "is this batch full" —
 * used by the Telegram Mini App / Admin Console today, and meant to be
 * called by the WhatsApp assistant later without re-implementing any of
 * this logic there.
 */

export interface BatchStatus {
  id: string;
  name: string;
  slug: string;
  college: string;
  status: string;
  batch_limit: number | null;
  fee_amount: number | null;
  enrolled: number;
  /** null = unlimited capacity */
  remaining: number | null;
}

async function withEnrollment(
  db: SupabaseClient,
  batch: {
    id: string; name: string; slug: string; college: string; status: string;
    batch_limit: number | null; fee_amount: number | null;
  } | null
): Promise<BatchStatus | null> {
  if (!batch) return null;
  // is_profile_complete=true — an abandoned registration (batch_id assigned,
  // form never finished) must not count against batch_limit and block a real
  // student from a seat that's actually free. Same bug class as the batch
  // count fixes in api/admin/batches, analytics, admin-menu.ts, etc.
  const { count } = await db
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .eq("batch_id", batch.id)
    // Enrolment, not role: an admin can also be an enrolled student — see services/enrollment.ts
    .eq("is_profile_complete", true);
  const enrolled  = count ?? 0;
  const remaining = batch.batch_limit == null ? null : Math.max(0, batch.batch_limit - enrolled);
  return { ...batch, enrolled, remaining };
}

/** The single active batch for a college, with live enrollment — or null if none is active. */
export async function getCurrentActiveBatch(db: SupabaseClient, college: string): Promise<BatchStatus | null> {
  const { data } = await db
    .from("batches")
    .select("id, name, slug, college, status, batch_limit, fee_amount")
    .eq("college", college)
    .eq("status", "active")
    .maybeSingle();
  return withEnrollment(db, data);
}

/** Full status + capacity snapshot for one batch, by id. */
export async function getBatchStatus(db: SupabaseClient, batchId: string): Promise<BatchStatus | null> {
  const { data } = await db
    .from("batches")
    .select("id, name, slug, college, status, batch_limit, fee_amount, telegram_invite_link")
    .eq("id", batchId)
    .maybeSingle();
  return withEnrollment(db, data);
}

/** Remaining seats for a batch. null = unlimited, undefined = batch not found. */
export async function getRemainingSlots(db: SupabaseClient, batchId: string): Promise<number | null | undefined> {
  const status = await getBatchStatus(db, batchId);
  return status ? status.remaining : undefined;
}

export interface CreateBatchInput {
  name: string;
  college: string;
  fee_amount: number;
  batch_limit?: number | null;
  upi_id?: string;
  upi_name?: string;
  description?: string;
  slug?: string;
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * Creates a batch. Shared by POST /api/admin/batches (admin form) and the
 * atomic batch-full auto-create flow — same slugging, same "active only if
 * the college has no other active batch yet" default.
 */
export async function createBatch(db: SupabaseClient, input: CreateBatchInput) {
  let slug = input.slug ? slugify(input.slug) : slugify(input.name);
  const { data: clash } = await db.from("batches").select("slug").ilike("slug", `${slug}%`);
  if (clash?.some((b: { slug: string }) => b.slug === slug)) {
    let n = 2;
    while (clash.some((b: { slug: string }) => b.slug === `${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }

  const { data: existingActive } = await db.from("batches")
    .select("id").eq("college", input.college).eq("status", "active").maybeSingle();
  const status = existingActive ? "paused" : "active";

  const upi_link = input.upi_id
    ? `upi://pay?pa=${encodeURIComponent(input.upi_id)}&pn=${encodeURIComponent(input.upi_name ?? "Fee Payment")}&am=${input.fee_amount}&cu=INR`
    : null;

  return db.from("batches").insert({
    name: input.name, college: input.college, slug, fee_amount: input.fee_amount,
    batch_limit: input.batch_limit ?? null, upi_id: input.upi_id ?? null,
    upi_name: input.upi_name ?? null, upi_link, description: input.description ?? null,
    status,
  }).select().single();
}

/**
 * Auto-creates a placeholder 'pending_setup' batch for a college with no
 * live batch at all (no active, no pending_setup) — called when a student
 * joins the waiting queue for that college. fee_amount is null since it's
 * not known yet; an admin fills it in later via setBatchFeeAndActivate(),
 * which flips status to 'active' and triggers waitlist processing.
 *
 * Race-safe: batches_one_live_per_college (unique index on college WHERE
 * status IN ('active','pending_setup')) is the actual guard. If two
 * requests race, the loser's insert hits 23505 and is treated as success —
 * a pending_setup (or active) batch exists either way, which is all this
 * function promises.
 *
 * Returns the pending_setup batch id, or null if the college already has
 * a live (active or pending_setup) batch — meaning nothing to do here.
 */
export async function ensurePendingSetupBatch(db: SupabaseClient, college: string): Promise<string | null> {
  const { data: existing } = await db
    .from("batches")
    .select("id")
    .eq("college", college)
    .in("status", ["active", "pending_setup"])
    .maybeSingle();
  if (existing) return null;

  const name = await nextBatchName(db, college);
  const slug = slugify(name);
  const { data, error } = await db
    .from("batches")
    .insert({ name, college, slug, status: "pending_setup", fee_amount: null })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return null; // lost the race — a live batch exists now, which is what we wanted
    throw error;
  }
  return data.id;
}

/**
 * Admin sets the fee (and optionally capacity) on a pending_setup batch,
 * activating it. Returns the activated batch, or null if it wasn't in
 * pending_setup state (already activated by someone else, or doesn't
 * exist) — callers should treat null as "nothing to do", not an error,
 * since this can legitimately race with another admin doing the same
 * thing.
 */
export async function setBatchFeeAndActivate(
  db: SupabaseClient,
  batchId: string,
  feeAmount: number,
  batchLimit: number | null
) {
  const { data, error } = await db
    .from("batches")
    .update({ status: "active", fee_amount: feeAmount, batch_limit: batchLimit })
    .eq("id", batchId)
    .eq("status", "pending_setup") // only ever activate from pending_setup — never silently reactivate a closed/paused batch
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** "GNIT Batch 3" — next sequential display name for a college. */
/**
 * Next batch name for a college — one past the highest number actually in use.
 *
 * This used to be `count(*) + 1`, which counts rather than reads the numbers.
 * Four archived test batches made GNIT's real second batch come out as
 * "GNIT Batch 6", and the count is wrong in both directions: deleting a batch
 * makes the next one reuse a name (production has two "GNIT Batch 1" rows from
 * exactly that), while archived rows inflate it forever.
 *
 * Archived batches are excluded from the sequence students see — they are
 * abandoned drafts, not batches anyone went through — but still counted for
 * collision safety below, since their slugs remain in the unique index.
 */
export async function nextBatchName(db: SupabaseClient, college: string): Promise<string> {
  const { data } = await db.from("batches").select("name, status").eq("college", college);

  const numberIn = (name: string | null): number => {
    const m = /\bBatch\s+(\d+)\b/i.exec(name ?? "");
    return m ? Number(m[1]) : 0;
  };

  const rows = data ?? [];
  const live = rows.filter((b: { status: string }) => String(b.status) !== "archived");
  const highestLive = Math.max(0, ...live.map((b: { name: string }) => numberIn(b.name)));
  const highestAny  = Math.max(0, ...rows.map((b: { name: string }) => numberIn(b.name)));

  // Prefer the next live number; skip past any archived name already holding
  // it so the generated slug can't collide with batches_slug_unique.
  let next = highestLive + 1;
  const taken = new Set(rows.map((b: { name: string }) => numberIn(b.name)));
  while (taken.has(next) && next <= highestAny) next++;

  return `${college} Batch ${next}`;
}

/** Fields carried over when the next batch is created from a previous one. */
export interface PreviousBatchCarry {
  fee_amount: number | null;
  batch_limit: number | null;
  upi_id: string | null;
  upi_name: string | null;
  extra_fee_amount: number | null;
  extra_fee_label: string | null;
  extra_fee_note: string | null;
  extra_fee_starts_at: string | null;
}

/**
 * Inserts the next sequential batch for a college, carrying over fee /
 * payment configuration from the previous batch. Returns the created row,
 * or null when a live batch already exists (lost a race with another
 * creator) — callers must re-read the live batch in that case.
 *
 * Shared by the eager close path (endBatchAndCreateNext) and the lazy
 * registration path (ensureActiveBatchForRegistration) so the "next batch"
 * is identical no matter which one creates it first.
 */
async function insertNextBatch(
  db: SupabaseClient,
  college: string,
  previous: PreviousBatchCarry,
): Promise<{ id: string; name: string; slug: string; college: string; fee_amount: number | string | null } | null> {
  const name = await nextBatchName(db, college);
  let slug = slugify(name);
  const { data: clash } = await db.from("batches").select("slug").ilike("slug", `${slug}%`);
  if (clash?.some((b: { slug: string }) => b.slug === slug)) {
    let n = 2;
    while (clash.some((b: { slug: string }) => b.slug === `${slug}-${n}`)) n++;
    slug = `${slug}-${n}`;
  }
  const { data, error } = await db.from("batches").insert({
    name, college, slug, status: "active",
    fee_amount: previous.fee_amount ?? null,
    batch_limit: previous.batch_limit ?? null,
    upi_id: previous.upi_id ?? null,
    upi_name: previous.upi_name ?? null,
    // The split fee carries over (e.g. ₹2,000 + ₹200); the second part starts
    // switched off until an admin turns it on for this batch.
    extra_fee_amount: previous.extra_fee_amount ?? null,
    extra_fee_label: previous.extra_fee_label ?? null,
    extra_fee_note: previous.extra_fee_note ?? null,
    extra_fee_enabled: false,
    // Opens by itself on the start date (item #229); a batch opened after it is open straight away.
    extra_fee_starts_at: previous.extra_fee_amount ? (previous.extra_fee_starts_at ?? "2026-10-15T00:00:00+05:30") : null,
    upi_link: previous.upi_id && previous.fee_amount
      ? `upi://pay?pa=${encodeURIComponent(previous.upi_id)}&pn=${encodeURIComponent(previous.upi_name ?? "Fee Payment")}&am=${previous.fee_amount}&cu=INR`
      : null,
  }).select("id, name, slug, college, fee_amount").single();
  if (error) {
    if (error.code === "23505") return null; // lost the race — a live batch exists now
    throw error;
  }
  return data;
}

/**
 * What a roll-over reads from the batch being closed: the money settings the
 * next batch inherits (see PreviousBatchCarry). One list so the End, status-edit
 * and repair paths cannot drift apart.
 */
export const BATCH_CARRY_COLUMNS =
  "fee_amount,batch_limit,upi_id,upi_name,extra_fee_amount,extra_fee_label,extra_fee_note,extra_fee_starts_at";

/** A closed batch as the roll-over needs it: who it is, plus what to carry over. */
export type ClosedBatchRow = PreviousBatchCarry & { id: string; name: string; college: string };

export interface TransferTarget {
  id: string;
  name: string;
  slug: string;
  college: string;
  /** Numeric (rule 4 — NUMERIC arrives as a string). null = no fee set yet. */
  fee_amount: number | null;
  /** True only when THIS call created the batch (not when it found or lost a race to one). */
  created: boolean;
}

/** The statuses the batches_one_live_per_college index treats as "live". */
const LIVE_BATCH_STATUSES = ["active", "pending_setup"];

function asTarget(
  row: { id: string; name: string; slug?: string | null; college: string; fee_amount?: number | string | null },
  created: boolean,
): TransferTarget {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug ?? "",
    college: row.college,
    fee_amount: row.fee_amount == null ? null : Number(row.fee_amount),
    created,
  };
}

/**
 * The transfer target when a batch closes: the college's current live batch,
 * creating the next sequential one when none exists yet. "Batch two" is
 * always the same college's next batch — never another college's.
 */
export async function resolveTransferTarget(
  db: SupabaseClient,
  college: string,
  previous: PreviousBatchCarry,
): Promise<TransferTarget> {
  const readLive = () => db.from("batches")
    .select("id, name, slug, college, fee_amount")
    .eq("college", college)
    .in("status", LIVE_BATCH_STATUSES)
    .maybeSingle();

  const { data: live } = await readLive();
  if (live) return asTarget(live, false);
  const created = await insertNextBatch(db, college, previous);
  if (created) return asTarget(created, true);
  // Lost the race — re-read the winner.
  const { data: raced } = await readLive();
  if (!raced) throw new Error("Could not resolve the next batch for transfer");
  return asTarget(raced, false);
}

/** `.in()` becomes part of the request URL — a few thousand ids would blow its length limit (item #102). */
const ID_CHUNK = 200;
function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Which of these students have an approved payment. Throws on a failed read:
 * guessing "nobody has paid" would move PAID students out of the batch they
 * paid into (the reads in this file return `{ data: null, error }` rather than
 * throwing, and `data ?? []` turns that into an empty set).
 */
export async function getPaidStudentIds(db: SupabaseClient, ids: string[]): Promise<Set<string>> {
  const paid = new Set<string>();
  for (const part of chunks(ids)) {
    const { data, error } = await db
      .from("payments")
      .select("student_id")
      .in("student_id", part)
      .eq("status", "approved");
    if (error) throw error;
    for (const row of data ?? []) paid.add((row as { student_id: string }).student_id);
  }
  return paid;
}

/**
 * Members of a batch with no approved payment — the ones a close moves.
 *
 * Paid = has an `approved` payment row (the same definition as
 * hasApprovedPayment and the batch stats route — an approved payment is never
 * shadowed by a later row). Everyone else is moved, registered or not: an
 * unfinished registration left in a closed batch could never be completed there.
 */
export async function findUnpaidMembers(db: SupabaseClient, batchId: string): Promise<string[]> {
  const { data: members, error } = await db.from("profiles").select("id").eq("batch_id", batchId);
  if (error) throw error;
  const ids = (members ?? []).map((m: { id: string }) => m.id);
  if (!ids.length) return [];
  const paid = await getPaidStudentIds(db, ids);
  return ids.filter((id: string) => !paid.has(id));
}

export interface TransferResult {
  moved: number;
  /** Exactly who moved (for the audit trail). */
  studentIds: string[];
  /**
   * Petition records re-pointed to the target batch: the ones of the students
   * just moved AND of anyone already sitting in the target whose record still
   * pointed at the closed batch (moved by an earlier run, or by the first
   * version of this feature, which did not move the record).
   */
  petitionsRepointed: number;
  /** The first failure, if any part of the move failed — what DID move is still reported above. */
  error: unknown | null;
}

/**
 * Moves every UNPAID member of a closed batch into the next batch.
 *
 * Paid students STAY in the closed batch: their records remain that completed
 * batch's history (court exhibits, payment queue, per-batch stats and the case
 * card all key off the batch they paid into). Unpaid students keep their
 * registered/unpaid status — payment rows are keyed by student_id, so a
 * pending/rejected attempt follows them and the admin can still review it; they
 * can pay the carried-over fee in the new batch.
 *
 * Safe to repeat and to double-tap: the move only matches rows still in the
 * closed batch, so a second run finds nothing new, and each student sits in
 * exactly one batch (`profiles.batch_id` is a single column).
 *
 * - Who moved is read from the ROWS the update returns, never from `count`
 *   (item #111: `count` is null unless the request asks for it).
 * - A payment can be approved between the read and the move (a gateway webhook
 *   landing as the admin taps End). Anyone who turns out to be paid is put back
 *   before their petition record is touched, so "paid stays paid" holds under
 *   a race too.
 * - Each student's petition record follows them (see movePetitionsToBatch),
 *   and so does the record of anyone ALREADY in the target whose petition still
 *   points at the closed batch — so pressing the repair button again converges
 *   the data whatever state an earlier run left it in.
 * - One failing chunk does not stop the others; the first error is returned so
 *   the caller can report it after recording what did move.
 */
export async function transferUnpaidStudents(
  db: SupabaseClient,
  fromBatchId: string,
  toBatchId: string,
): Promise<TransferResult> {
  if (!fromBatchId || !toBatchId || fromBatchId === toBatchId) return { moved: 0, studentIds: [], petitionsRepointed: 0, error: null };

  const unpaid = await findUnpaidMembers(db, fromBatchId);

  let error: unknown | null = null;
  let movedIds: string[] = [];
  for (const part of chunks(unpaid)) {
    const { data, error: moveError } = await db
      .from("profiles")
      .update({ batch_id: toBatchId })
      .eq("batch_id", fromBatchId)
      .in("id", part)
      .select("id");
    if (moveError) { error ??= moveError; continue; }
    movedIds.push(...(data ?? []).map((r: { id: string }) => r.id));
  }

  if (movedIds.length) {
    try {
      const paidNow = await getPaidStudentIds(db, movedIds);
      if (paidNow.size) {
        for (const part of chunks([...paidNow])) {
          const { error: backError } = await db
            .from("profiles")
            .update({ batch_id: fromBatchId })
            .eq("batch_id", toBatchId)
            .in("id", part);
          if (backError) error ??= backError;
        }
        movedIds = movedIds.filter((id) => !paidNow.has(id));
      }
    } catch (e) {
      // Could not re-check. The students above are unpaid as far as the first
      // read knew; report the failure rather than guess either way.
      error ??= e;
    }
  }

  // Petitions follow everyone who is in the target batch now (those just moved
  // and anyone moved earlier). The closed batch is part of the filter, so a
  // record that already points elsewhere is left alone.
  let petitionsRepointed = 0;
  try {
    const { data: inTarget, error: readError } = await db.from("profiles").select("id").eq("batch_id", toBatchId);
    if (readError) throw readError;
    const ids = (inTarget ?? []).map((r: { id: string }) => r.id);
    if (ids.length) petitionsRepointed = await movePetitionsToBatch(db, ids, fromBatchId, toBatchId);
  } catch (e) {
    console.error("[transferUnpaidStudents] could not re-point petitions:", e);
    error ??= e;
  }
  return { moved: movedIds.length, studentIds: movedIds, petitionsRepointed, error };
}

/** Which half of a roll-over failed — they need different words for the admin. */
export class RollOverError extends Error {
  constructor(public phase: "create" | "transfer", public cause: unknown) {
    super(`batch roll-over failed while ${phase === "create" ? "creating the next batch" : "moving students"}: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "RollOverError";
  }
}

/** More ids than this make an audit row unwieldy; the count is always exact. */
const MAX_AUDITED_STUDENT_IDS = 500;

/**
 * Everything that has to happen once a batch is closed, in one place — shared
 * by End Batch (website, WhatsApp, Copilot), a status edit to "closed", and the
 * repair button, so the rule cannot drift between them:
 *
 *   1. find the college's live batch, creating the next one if there is none;
 *   2. move the unpaid members into it (paid ones stay);
 *   3. record who moved;
 *   4. if this created the batch, tell the college's waiting list it is open.
 *
 * Idempotent: with nothing left to move it only re-reads. Throws RollOverError.
 */
export async function rollOverClosedBatch(
  db: SupabaseClient,
  batch: ClosedBatchRow,
  actorId: string | null,
  opts: { repaired?: boolean } = {},
): Promise<{ target: TransferTarget; moved: number }> {
  let target: TransferTarget;
  try {
    target = await resolveTransferTarget(db, batch.college, batch);
  } catch (e) {
    throw new RollOverError("create", e);
  }

  let transfer: TransferResult;
  try {
    transfer = await transferUnpaidStudents(db, batch.id, target.id);
  } catch (e) {
    throw new RollOverError("transfer", e);
  }

  // A fresh close is always recorded (even with nobody to move); a repair only when it changed something.
  if (transfer.moved > 0 || transfer.petitionsRepointed > 0 || !opts.repaired) {
    try {
      await audit("batch.students_transferred", "batch", batch.id, {
        college: batch.college,
        to_batch: target.id,
        to_batch_name: target.name,
        moved_unpaid: transfer.moved,
        petitions_repointed: transfer.petitionsRepointed,
        student_ids: transfer.studentIds.slice(0, MAX_AUDITED_STUDENT_IDS),
        next_batch_created: target.created,
        ...(opts.repaired ? { repaired: true } : {}),
        ...(transfer.error ? { partial: true } : {}),
      }, actorId ?? undefined, actorId ? "admin" : "system");
    } catch (e) { console.error("[rollOverClosedBatch] transfer audit failed:", e); }
  }

  // The moment a batch comes into existence is when the people who asked to be
  // told that this college has one open should hear about it. Elsewhere the
  // waiting list is only processed when an admin creates or activates a batch
  // by hand, which a roll-over is not.
  if (target.created) {
    try {
      const { processWaitlistForCollege } = await import("@/lib/services/waitlist-processing");
      await processWaitlistForCollege(db, batch.college);
    } catch (e) { console.error("[rollOverClosedBatch] waitlist processing failed:", e); }
  }

  if (transfer.error) throw new RollOverError("transfer", transfer.error);
  return { target, moved: transfer.moved };
}

/** Create the next batch lazily, on the first registration attempt after closure. */
export async function ensureActiveBatchForRegistration(db: SupabaseClient, college: string): Promise<BatchStatus | null> {
  const current = await getCurrentActiveBatch(db, college);
  if (current) return current;
  const { data: previous } = await db.from("batches").select("id,name,college,status,fee_amount,batch_limit,upi_id,upi_name,extra_fee_amount,extra_fee_label,extra_fee_note,extra_fee_starts_at").eq("college", college).eq("status", "closed").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!previous) return null;
  // insertNextBatch returns null when it loses a race — a live batch exists
  // either way, which is all this function promises.
  await insertNextBatch(db, college, previous as PreviousBatchCarry);
  return getCurrentActiveBatch(db, college);
}

export type EndBatchResult =
  | { ok: true; newBatch: { id: string; name: string; slug: string; college: string; fee_amount: number | null }; endedName: string; movedStudents: number; repaired?: boolean }
  | { ok: false; reason: "not_found" | "not_active" | "create_failed" | "transfer_failed" };

export type EndBatchFailure = Extract<EndBatchResult, { ok: false }>["reason"];

/**
 * Plain-language reason an End Batch call failed — one wording for every
 * surface (website, WhatsApp, Copilot). `batchClosed` matters: after
 * "create_failed" and "transfer_failed" the batch IS closed, so "try again"
 * must point at the repair button, not at End (which only lists Active batches).
 */
export function describeEndBatchFailure(reason: EndBatchFailure): { message: string; batchClosed: boolean } {
  switch (reason) {
    case "not_found":
      return { message: "That batch was not found.", batchClosed: false };
    case "not_active":
      return { message: "Only the currently Active batch can be ended.", batchClosed: false };
    case "create_failed":
      return {
        message: "The batch is now closed, but the next batch could not be created. Use “Move unpaid to next batch” on the closed batch (Admin → Batches) to finish — it creates the next batch and moves the unpaid students.",
        batchClosed: true,
      };
    case "transfer_failed":
      return {
        message: "The batch is now closed and the next batch is open, but moving the unpaid students did not finish. Use “Move unpaid to next batch” on the closed batch (Admin → Batches) to finish — it is safe to repeat.",
        batchClosed: true,
      };
  }
}

/**
 * What an End Batch did, as short lines for an admin message. `bold` lets
 * WhatsApp wrap names in *…* while plain-text surfaces pass nothing. Says
 * whether the next batch can take payments yet, because the fee carries over
 * from the closed batch and is only missing if that one had none either.
 */
export function endBatchSummaryLines(
  r: Extract<EndBatchResult, { ok: true }>,
  bold: (s: string) => string = (s) => s,
): string[] {
  const { newBatch, endedName, movedStudents } = r;
  const lines = [
    r.repaired ? `${bold(endedName)} was already closed.` : `${bold(endedName)} is now closed.`,
    `${bold(newBatch.name)} is the Active batch for ${newBatch.college}.`,
  ];
  if (movedStudents > 0) {
    lines.push(`${movedStudents} unpaid student${movedStudents === 1 ? "" : "s"} moved to ${bold(newBatch.name)}. Paid students stay in ${bold(endedName)}.`);
  } else {
    lines.push(r.repaired ? "Nobody was left to move." : `No unpaid students needed to move. Paid students stay in ${bold(endedName)}.`);
  }
  lines.push(
    newBatch.fee_amount
      ? `Fee carried over: ₹${newBatch.fee_amount.toLocaleString("en-IN")}.`
      : `No fee is set on ${bold(newBatch.name)} yet — students can register but cannot pay until you set one.`,
  );
  return lines;
}

/**
 * The ONLY sanctioned way a new batch comes into existence after the first:
 * the admin explicitly ends the current Active batch. Closes it, creates the
 * next sequential batch as the college's single Active batch (Issue #1/#41),
 * and moves every UNPAID member over automatically (rollOverClosedBatch). Paid
 * members stay in the closed batch as its history.
 *
 * Fee / payment configuration carries over to the new batch (same carry-over
 * the lazy registration path uses), so transferred students can pay
 * immediately. Admins are notified immediately (Telegram + WhatsApp) via the
 * ZIP export of the closed batch.
 *
 * Idempotent and safe to double-tap: only one caller wins the active→closed
 * update (decided from the returned row), the next-batch insert is guarded by
 * the one-live-batch-per-college index, and ending an already-ended batch only
 * completes whatever transfer is still outstanding (self-heal for partial
 * failures and for batches closed before the transfer existed). Shared by the
 * website admin route and the WhatsApp / Copilot admin surfaces, so the rule
 * lives in exactly one place.
 */
export async function endBatchAndCreateNext(db: SupabaseClient, batchId: string, actorId: string | null): Promise<EndBatchResult> {
  const { data: batch } = await db.from("batches").select(`id,name,college,status,${BATCH_CARRY_COLUMNS}`).eq("id", batchId).maybeSingle();
  if (!batch) return { ok: false, reason: "not_found" };

  const failure = (e: unknown): EndBatchResult => {
    console.error("[endBatchAndCreateNext] roll-over failed:", e);
    return { ok: false, reason: e instanceof RollOverError && e.phase === "transfer" ? "transfer_failed" : "create_failed" };
  };
  const success = (target: TransferTarget, moved: number, repaired?: boolean): EndBatchResult => ({
    ok: true,
    newBatch: { id: target.id, name: target.name, slug: target.slug, college: batch.college, fee_amount: target.fee_amount },
    endedName: batch.name,
    movedStudents: moved,
    ...(repaired ? { repaired: true } : {}),
  });

  // Self-heal: a previous close (or a direct status edit) may have left
  // unpaid students stranded in this closed batch. Finish the transfer
  // instead of erroring — this also repairs batches closed before the
  // transfer existed. Paid students are never touched.
  if (batch.status === "closed") {
    try {
      const { target, moved } = await rollOverClosedBatch(db, batch as ClosedBatchRow, actorId, { repaired: true });
      return success(target, moved, true);
    } catch (e) { return failure(e); }
  }
  if (batch.status !== "active") return { ok: false, reason: "not_active" };

  const { data: closed } = await db.from("batches").update({ status: "closed" }).eq("id", batchId).eq("status", "active").select("id").maybeSingle();
  if (!closed) return { ok: false, reason: "not_active" };
  await audit("batch.ended", "batch", batchId, { college: batch.college }, actorId ?? undefined, actorId ? "admin" : "system");
  try {
    const token = await issueExportToken(db, batchId, actorId ?? "system");
    const admins = await db.from("admins").select("phone").eq("active", true);
    if (token && admins.data?.length) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev";
      const zipUrl = `${appUrl}/api/admin/export/docx/${batchId}/zip?xt=${encodeURIComponent(token)}`;
      const filename = `${batch.name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_")}_export.zip`;
      await Promise.all(admins.data.map((a: { phone: string }) => sendWhatsAppDocument(a.phone, zipUrl, filename, `${batch.name} closed — student ZIP export`)));
    }
  } catch (e) { console.error("[endBatchAndCreateNext] ZIP notification failed:", e); }

  // The next batch is created NOW (the admin UI already promises this), and
  // every unpaid member moves over automatically. Paid members stay — they
  // are this batch's history, and the ZIP court exhibit above still resolves
  // them here at click time.
  try {
    const { target, moved } = await rollOverClosedBatch(db, batch as ClosedBatchRow, actorId);
    return success(target, moved);
  } catch (e) { return failure(e); }
}

/**
 * @deprecated DISABLED — automatic batch creation is forbidden (Issue #1/#41).
 *
 * This used to flip a batch to "full" at batch_limit, auto-create the next
 * batch, and move the overflowing student into it. That split a college's
 * registrations across multiple batches — the production bug. A college must
 * have exactly ONE Active batch that every registration joins regardless of
 * count; the next batch is created ONLY when the admin explicitly ends the
 * current one (POST /api/admin/batches/[id]/end).
 *
 * Kept as a guaranteed no-op so any lingering caller (or a stale "batch full"
 * admin button) can never re-introduce automatic creation. Do not re-enable.
 */
export async function checkAndMarkBatchFull(
  _db: SupabaseClient,
  _batchId: string,
  _studentId?: string
): Promise<string | null> {
  return null;
}
