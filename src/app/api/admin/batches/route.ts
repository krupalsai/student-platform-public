import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin, requireAdmin } from "@/lib/session";
import { ok, forbidden, serverError, zodError, fieldError, dbError } from "@/lib/api-response";
import { createBatch } from "@/lib/services/batches";
import { processWaitlistForCollege } from "@/lib/services/waitlist-processing";
import { logSystemError } from "@/lib/system-errors";
import { adminBatchIds } from "@/lib/authz";

// student_count changes as registrations complete/batches change — never
// serve a stale cached response for this route (same reasoning as
// batch-summary and seat-progress).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const CreateSchema = z.object({
  name:        z.string().trim().min(2).max(120),
  college:     z.string().trim().min(1).max(50),  // validated against DB below — no hardcoded enum
  fee_amount:  z.number().positive(),
  batch_limit: z.number().int().positive().nullable().optional(), // null/omitted = unlimited
  upi_id:      z.string().trim().optional(),
  upi_name:    z.string().trim().optional(),
  description: z.string().max(500).optional(),
  slug:        z.string().trim().min(2).max(80).optional(),
});

export async function POST(req: NextRequest) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();

  try {
    const body = CreateSchema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const db = createServiceClient();
    const { data: collegeRow } = await db.from("colleges").select("id").eq("id", body.data.college).eq("active", true).maybeSingle();
    if (!collegeRow) return fieldError("college", "Invalid college");
    const { data, error: err } = await createBatch(db, body.data);

    if (err) return dbError("api/admin/batches", err);

    // createBatch() only sets status='active' when no other batch was
    // already active for this college — i.e. exactly the "registration
    // was paused, waitlist was accumulating, now it's open" case.
    if (data?.status === "active") {
      // AWAITED: unawaited work is killed when the lambda freezes after the
      // response — waitlisted students would never receive their link.
      await processWaitlistForCollege(db, body.data.college).catch(e =>
        console.error("[api/admin/batches] waitlist processing failed:", e)
      );
    }

    return ok(data);
  } catch (err) { console.error("[api/admin/batches]", err);
    await logSystemError(createServiceClient(), "api/admin/batches", err);
    return serverError();
  }
}

export async function GET(req: NextRequest) {
  const { user, error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  const db = createServiceClient();

  // Batch isolation: normal admins only see their assigned batches
  const assignedBatchIds = await adminBatchIds(db, user!.profileId, user!.role);
  const college = req.nextUrl.searchParams.get("college") ?? "";
  const showAll = req.nextUrl.searchParams.get("all") === "1";
  const activeOnly = req.nextUrl.searchParams.get("active_only") === "1";

  // Core columns only — these have existed since the original schema and
  // are guaranteed to be present. low_seat_alert_threshold is fetched
  // separately below so that a not-yet-migrated database can never take
  // down the entire batches list (this previously caused a full 500here
  // when that column didn't exist yet in production).
  let q = db
    .from("batches")
    .select("id, name, slug, college, status, fee_amount, upi_id, upi_name, description, batch_limit, created_at, updated_at, case_type, case_number, case_year, case_status_url, representative_name, representative_phone, extra_fee_amount, extra_fee_label, extra_fee_note, extra_fee_enabled, extra_fee_starts_at")
    .order("name", { ascending: true }); // Batch 1 before Batch 2

  if (!showAll) q = q.neq("status", "archived");
  if (activeOnly) q = q.eq("status", "active");
  if (college) q = q.eq("college", college);
  // Enforce batch isolation for non-super admins
  if (assignedBatchIds !== null) {
    if (assignedBatchIds.length === 0) return ok([]);
    q = q.in("id", assignedBatchIds);
  }

  const { data: batches, error: bErr } = await q;
  if (bErr) return dbError("api/admin/batches GET", bErr);

  // Attach member counts (profiles per batch)
  const batchIds = (batches ?? []).map((b: any) => b.id);
  let memberCounts: Record<string, number> = {};
  if (batchIds.length > 0) {
    const { data: counts } = await db
      .from("profiles")
      .select("batch_id")
      .in("batch_id", batchIds);
    for (const p of counts ?? []) {
      const bid = (p as any).batch_id;
      if (bid) memberCounts[bid] = (memberCounts[bid] ?? 0) + 1;
    }
  }
  const batchesWithCounts = (batches ?? []).map((b: any) => ({
    ...b,
    member_count: memberCounts[b.id] ?? 0,
  }));
  if (!batches || batches.length === 0) return ok([]);

  // batchIds was already declared above (member_count pass) and covers the
  // rest of this handler — batches is known non-empty past the guard.

  // Count enrolled students per batch (profiles assigned to each batch).
  // is_profile_complete=true only — otherwise this counts abandoned
  // registration attempts (batch_id assigned, form never finished) as
  // enrolled students. Confirmed live: this exact gap made the Batches list
  // show 25/55 for batches whose real registered counts were 18/24.
  // Every member row is read (finished or not) so the same pass can also say who
  // has paid; `student_count` below still counts finished registrations only.
  // Enrolment, not role: an admin can also be an enrolled student — see services/enrollment.ts
  const { data: members } = await db
    .from("profiles")
    .select("id, batch_id, is_profile_complete")
    .in("batch_id", batchIds);

  const countMap: Record<string, number> = {};
  for (const row of members ?? []) {
    if (row.batch_id && row.is_profile_complete) countMap[row.batch_id] = (countMap[row.batch_id] ?? 0) + 1;
  }

  // Who has paid (an approved payment), so a closed batch can say plainly
  // "all paid, nobody waiting" instead of leaving the admin to wonder whether
  // anyone is stranded in it. If this read fails the numbers are left out
  // (null) — a missing figure is honest, "0 waiting" built on a failed read is
  // not. Chunked: `.in()` is part of the request URL.
  const paidMap: Record<string, number> = {};
  const notPaidMap: Record<string, number> = {};
  let paidKnown = true;
  const paidIds = new Set<string>();
  const memberIds = (members ?? []).map(m => m.id as string);
  for (let i = 0; i < memberIds.length; i += 200) {
    const { data: paidRows, error: paidErr } = await db
      .from("payments")
      .select("student_id")
      .eq("status", "approved")
      .in("student_id", memberIds.slice(i, i + 200));
    if (paidErr) {
      console.error("[api/admin/batches] paid lookup failed:", paidErr.message);
      paidKnown = false;
      break;
    }
    for (const r of paidRows ?? []) if (r.student_id) paidIds.add(r.student_id as string);
  }
  if (paidKnown) {
    for (const row of members ?? []) {
      if (!row.batch_id) continue;
      if (paidIds.has(row.id as string)) {
        if (row.is_profile_complete) paidMap[row.batch_id] = (paidMap[row.batch_id] ?? 0) + 1;
      } else {
        // Anyone without an approved payment, finished registration or not —
        // exactly the people "Move unpaid to next batch" would move.
        notPaidMap[row.batch_id] = (notPaidMap[row.batch_id] ?? 0) + 1;
      }
    }
  }

  // Best-effort fetch of low_seat_alert_threshold — if the migration
  // hasn't been run yet, this query fails silently and every batch just
  // shows no alert threshold, instead of breaking the whole list.
  let thresholdMap: Record<string, number | null> = {};
  try {
    const { data: thresholds, error: tErr } = await db
      .from("batches")
      .select("id, low_seat_alert_threshold")
      .in("id", batchIds);
    if (!tErr && thresholds) {
      for (const row of thresholds) {
        thresholdMap[row.id] = (row as any).low_seat_alert_threshold ?? null;
      }
    }
  } catch (err) { console.error("[api/admin/batches]", err);
    // Column likely doesn't exist yet in this database — safe to ignore.
  }

  // Who has paid the batch's separate second payment (extra_fee_payments).
  const extraPaidMap: Record<string, number> = {};
  const { data: extraPaid } = await db.from("extra_fee_payments")
    .select("batch_id").in("batch_id", batchIds).eq("status", "paid");
  for (const row of extraPaid ?? []) extraPaidMap[row.batch_id] = (extraPaidMap[row.batch_id] ?? 0) + 1;

  const result = batchesWithCounts.map(b => ({
    ...b,
    student_count: countMap[b.id] ?? 0,
    paid_count: paidKnown ? (paidMap[b.id] ?? 0) : null,
    not_paid_count: paidKnown ? (notPaidMap[b.id] ?? 0) : null,
    extra_fee_paid_count: extraPaidMap[b.id] ?? 0,
    low_seat_alert_threshold: thresholdMap[b.id] ?? null,
  }));

  return ok(result);
}

// DELETE /api/admin/batches?id=<batchId>
// SAFETY: Only super_admin can delete, and only ARCHIVED batches.
// This is irreversible.
export async function DELETE(req: NextRequest) {
  const { error, user: session } = await requireAdmin(req);
  if (error) return forbidden();
  // Only super_admin (requireAdmin allows admin too - check role)
  const role = (session as any)?.role ?? "";
  if (role !== "super_admin") return forbidden();

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fieldError("id", "Batch ID required");

  const db = createServiceClient();

  // Verify batch exists and is archived
  const { data: batch, error: bErr } = await db
    .from("batches")
    .select("id, name, status")
    .eq("id", id)
    .single();
  if (bErr || !batch) return dbError("api/admin/batches DELETE lookup", bErr);
  if ((batch as any).status !== "archived") {
    return fieldError("id", "Only archived batches can be deleted");
  }

  // Check for students (safety - warn but allow if user confirms via force flag)
  const force = new URL(req.url).searchParams.get("force") === "1";
  const { count: studentCount } = await db
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", id);
  if ((studentCount ?? 0) > 0 && !force) {
    return fieldError("id", `Batch has ${studentCount} students. Add ?force=1 to delete anyway.`);
  }

  const { error: dErr } = await db.from("batches").delete().eq("id", id);
  if (dErr) return dbError("api/admin/batches DELETE", dErr);

  return ok({ deleted: id, name: (batch as any).name });
}
