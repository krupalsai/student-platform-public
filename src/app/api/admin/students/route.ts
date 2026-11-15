import { NextRequest } from "next/server";
// Force redeploy 2026-10-19 21:35 IST - super_admin batch filter fix
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin, requireSuperAdmin } from "@/lib/session";
import { ok, created, forbidden, serverError, conflict, dbError, zodError, fieldError } from "@/lib/api-response";
import { bestPaymentPerStudent } from "@/lib/services/payments";
import { normalizePhone } from "@/lib/services/students";
import { autoApprovePayment } from "@/lib/auto-approve";
import { audit } from "@/lib/audit";
import { adminBatchIds } from "@/lib/authz";

/**
 * `.in("student_id", ids)` becomes a querystring, so a single call with a few
 * thousand ids blows past PostgREST's URL limit and starts failing outright.
 * Every id-list lookup in this route goes through a chunked read instead, so
 * the roster keeps working as the platform grows rather than breaking at some
 * unannounced size.
 */
const ID_CHUNK = 200;

interface PayRow { id: string; student_id: string; status: string; utr_number: string | null; created_at: string }

async function paymentsForStudents(db: ReturnType<typeof createServiceClient>, ids: string[]): Promise<PayRow[]> {
  const out: PayRow[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data } = await db
      .from("payments")
      .select("id, student_id, status, utr_number, created_at")
      .in("student_id", ids.slice(i, i + ID_CHUNK))
      .order("created_at", { ascending: false });
    if (data) out.push(...(data as PayRow[]));
  }
  return out;
}

/** Student ids in scope for the current roster filters — never the whole platform. */
async function candidateStudentIds(
  db: ReturnType<typeof createServiceClient>,
  college: string,
  batchId: string,
  assignedBatchIds: string[] | null,
): Promise<string[]> {
  // // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
  let q = db.from("profiles").select("id").or("role.eq.student,batch_id.not.is.null");
  if (college) q = q.eq("college", college);
  // Disabled per analysis - if (batchId) q = q.eq("batch_id", batchId);
  if (assignedBatchIds !== null) {
    if (assignedBatchIds.length === 0) return [];
    if (assignedBatchIds !== null) q = q.in("batch_id", assignedBatchIds);
  }
  const { data } = await q;
  return (data ?? []).map(s => s.id);
}

export async function GET(req: NextRequest) {
  const { user, error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  const p = req.nextUrl.searchParams;
  const q        = p.get("q") ?? "";
  const college  = p.get("college") ?? "";
  const batch_id = p.get("batch_id") ?? "";
  // "paid" | "review" | "not_paid" | "rejected" | "" (any)
  const payStatus = p.get("pay_status") ?? "";
  const page     = Math.max(1, parseInt(p.get("page") ?? "1"));
  const limit    = 500;
  const from     = (page - 1) * limit;

  try {
    const db = createServiceClient();

    // Batch isolation: normal admins only see their assigned batches
    const assignedBatchIds = await adminBatchIds(db, user!.profileId, user!.role);

    // If filtering by payment status, first resolve which student IDs match,
    // since payments live in a separate table (one-to-many per student — we
    // take each student's BEST payment as their current status: an approved
    // payment always wins over a later stray/duplicate row, never just
    // whichever row happens to be most recent — see PAYMENT_STATUS_PRIORITY
    // in services/payments.ts; a "most recent row"
    // reducer here dropped an approved student off the Paid filter entirely
    // because a duplicate pending order got created 10s after their approval).
    let matchingStudentIds: string[] | null = null;
    let cachedPayRows: PayRow[] | null = null;
    if (payStatus) {
      // Scoped to the same college/batch the roster itself is showing, and
      // fetched in chunks. This used to select EVERY payment row and EVERY
      // student profile platform-wide on each filtered load, with no filter
      // and no limit — fine at 56 payments, but it grows with every batch
      // forever, and the API role runs under an 8s statement_timeout, so it
      // was a guaranteed future failure (and a silent-truncation risk if a
      // PostgREST max-rows cap is ever set). Never reintroduce an unfiltered
      // select over payments/profiles here.
      const candidateIds = await candidateStudentIds(db, college, batch_id, assignedBatchIds);

      const payRows = await paymentsForStudents(db, candidateIds);
      cachedPayRows = payRows;
      const bestByStudent = bestPaymentPerStudent(payRows);
      const latestByStudent: Record<string, string> = {};
      for (const [id, row] of Object.entries(bestByStudent)) {
        latestByStudent[id] = row.status;
      }

      const wanted = new Set(
        payStatus === "paid"     ? ["approved"] :
        payStatus === "review"   ? ["submitted"] :
        payStatus === "rejected" ? ["rejected", "reupload_requested"] :
        payStatus === "failed"   ? ["pg_failed"] :
        [] // "not_paid" handled separately below (absence of any payment row too)
      );

      if (payStatus === "not_paid") {
        const studentsWithPayments = new Set(Object.keys(latestByStudent));
        matchingStudentIds = candidateIds.filter(id => {
          const status = latestByStudent[id];
          // Excludes pg_failed on purpose — that's its own distinct card/filter
          // (pay_status=failed) now, so the two buckets don't overlap.
          return !studentsWithPayments.has(id) || status === "pending" || status === "pg_pending";
        });
      } else {
        matchingStudentIds = Object.entries(latestByStudent)
          .filter(([, status]) => wanted.has(status))
          .map(([id]) => id);
      }
    }

    let query = db.from("profiles")
      .select(
        "id,full_name,father_name,college_id_path,college_id_ai_flag,photo_signature_path,username,phone,college,roll_number,branch,year,semester,is_profile_complete,role,batch_id,created_at,batches!profiles_batch_id_fkey(name,slug,fee_amount,college)",
        { count: "exact" }
      )
      // A student account, OR any account actually enrolled in a batch — a
      // dual-role admin who registered belongs on their batch roster. // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
      .or("role.eq.student,batch_id.not.is.null");

    if (college)  query = query.eq("college", college);
    if (batch_id) query = query.eq("batch_id", batch_id);
    // Enforce batch isolation for non-super admins
    if (assignedBatchIds !== null) {
      if (assignedBatchIds.length === 0) {
        return ok({ students: [], total: 0, page, limit });
      }
      if (assignedBatchIds !== null) query = query.in("batch_id", assignedBatchIds);
    }
    if (q)        query = query.or(`full_name.ilike.%${q}%,roll_number.ilike.%${q}%,phone.ilike.%${q}%`);
    if (matchingStudentIds !== null) {
      if (matchingStudentIds.length === 0) {
        return ok({ students: [], total: 0, page, limit });
      }
      query = query.in("id", matchingStudentIds);
    }

    const { data, count, error: err } = await query
      .order("created_at", { ascending: false })
      .range(from, from + limit - 1);

    if (err) return serverError();

    // Attach payment_order / batch_approved_total (same numbers shown on the
    // Payments page) so a student who paid shows their position here too.
    const studentIds = (data ?? []).map(s => s.id);
    let orderByStudent: Record<string, { payment_order: number; batch_approved_total: number }> = {};
    if (studentIds.length > 0) {
      const { data: orderRows } = await db
        .from("admin_payment_queue")
        .select("student_id, payment_order, batch_approved_total")
        .eq("payment_status", "approved")
        .in("student_id", studentIds);
      for (const row of orderRows ?? []) {
        orderByStudent[row.student_id] = {
          payment_order: row.payment_order,
          batch_approved_total: row.batch_approved_total,
        };
      }
    }
    // Attach each student's BEST payment (status + UTR + id) so the roster
    // shows who has actually paid and links straight to the receipt for manual
    // verification — without leaving this screen. This matters when the payment
    // gateway is down and every payment is verified by hand from the UTR +
    // screenshot. Approved always wins over a later stray row (see
    // PAYMENT_STATUS_PRIORITY) so an approved student's card never shows a
    // later duplicate/failed attempt instead of their real receipt.
    let payByStudent: Record<string, { pay_status: string; utr_number: string | null; payment_id: string }> = {};
    if (studentIds.length > 0) {
      // Reuse the payments already fetched for the pay-status filter (when
      // set) instead of querying the payments table a second time for the
      // same students — the roster page already has their payment rows.
      const payRows = cachedPayRows
        ? cachedPayRows.filter(r => studentIds.includes(r.student_id))
        : await paymentsForStudents(db, studentIds);
      const best = bestPaymentPerStudent(payRows);
      for (const [id, row] of Object.entries(best)) {
        payByStudent[id] = { pay_status: row.status, utr_number: row.utr_number, payment_id: row.id };
      }
    }

    const students = (data ?? []).map(s => ({
      ...s,
      ...orderByStudent[s.id],
      ...(payByStudent[s.id] ?? { pay_status: "none", utr_number: null, payment_id: null }),
    }));
    // Under the Paid filter every row has a payment_order — show #1 first
    // instead of the registration-date order used for the general roster.
    if (payStatus === "paid") {
      students.sort((a, b) => (a.payment_order ?? 0) - (b.payment_order ?? 0));
    }

    // Admins per batch (for the "Make as Admin" button, which hides once a
    // batch reaches the max of 2 — the make-admin API enforces the same cap
    // server-side). Union of both sources, same as the make-admin count:
    // profiles with role='admin' in the batch + assignment rows.
    const adminCounts: Record<string, number> = {};
    try {
      const byBatch = new Map<string, Set<string>>();
      const { data: adminProfiles } = await db.from("profiles")
        .select("id, batch_id").eq("role", "admin").not("batch_id", "is", null);
      for (const r of adminProfiles ?? []) {
        if (!byBatch.has(r.batch_id)) byBatch.set(r.batch_id, new Set());
        byBatch.get(r.batch_id)!.add(r.id);
      }
      const { data: assignRows } = await db.from("admin_batch_assignments")
        .select("admin_id, batch_id");
      for (const r of assignRows ?? []) {
        if (!byBatch.has(r.batch_id)) byBatch.set(r.batch_id, new Set());
        byBatch.get(r.batch_id)!.add(r.admin_id);
      }
      for (const [batchId, ids] of byBatch) adminCounts[batchId] = ids.size;
    } catch { /* counts are a UI hint only — never fail the roster for them */ }

    return ok({ students, total: count ?? 0, page, limit, admin_counts: adminCounts });
  } catch (err) { console.error("[api/admin/students]", err);
    return serverError();
  }
}

/**
 * Create a student by hand — the "registered at spot" case.
 *
 * Some students register in person: they pay the fee on the spot and send
 * their details over WhatsApp, never touching the app. They exist as a paid
 * petitioner in real life and as NOTHING in the platform, which is the actual
 * problem this solves — an unrecorded spot student is missing from their
 * batch's roster, from the paid count, and from the DOCX court exhibit.
 *
 * Only three things are required — name, phone, batch — because those are all
 * an admin actually has from a WhatsApp message. College is deliberately NOT
 * a separate field: it is derived from whichever batch is picked (every batch
 * belongs to exactly one college, and its name already says which — "GNIT
 * Batch 1"), so there is no second dropdown to keep in sync with the first and
 * no way for the two to disagree. Everything the normal registration form
 * demands (father's name, roll number, branch, year, College ID photo,
 * address) stays null and can be filled in later by the student through
 * Correction, or by an admin on the roster. The profile is still marked
 * COMPLETE: that flag is what makes someone count as enrolled
 * (services/enrollment.ts), and a spot student who paid is unambiguously
 * enrolled. Leaving it false would hide them from every count that matters,
 * which is the bug this route exists to prevent.
 */

const CreateStudentSchema = z.object({
  full_name:    z.string().trim().min(2).max(120),
  phone:        z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  batch_id:     z.string().trim().uuid("Pick a batch"),

  // Everything below is genuinely optional — an admin working from a WhatsApp
  // message usually has none of it.
  father_name:  z.string().trim().min(2).max(120).optional(),
  roll_number:  z.string().trim().min(2).max(50).optional(),
  branch:       z.string().trim().min(1).max(80).optional(),
  year:         z.string().trim().min(1).max(20).optional(),

  /** They paid at the spot, so this defaults ON. */
  mark_paid:    z.boolean().optional().default(true),
  /** Defaults to the batch's own fee. */
  amount:       z.number().positive().max(1_000_000).optional(),
  /** Receipt number, "cash at spot", whoever collected it — free text. */
  payment_note: z.string().trim().max(200).optional(),
});

export async function POST(req: NextRequest) {
  // Super-admin only, per explicit request — a plain admin can monitor and
  // edit students (GET/PATCH on [id]) but must not be able to create one
  // out of thin air. Same tier item #110 already put the console itself
  // behind, and item #64's class of "restrict a real mutation, not a whole
  // screen" reasoning.
  const { user, error } = await requireSuperAdmin(req);
  if (error) return forbidden();
  const db = createServiceClient();

  try {
    const parsed = CreateStudentSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return zodError(parsed.error);
    const input = parsed.data;
    const phone = normalizePhone(input.phone);

    // 1. Batch first — college is now DERIVED from it, never a separate
    //    field the admin picks. Every batch belongs to exactly one college
    //    and its own name already says which ("GNIT Batch 1"), so asking for
    //    college up front was a redundant step that could also disagree with
    //    the batch (item #136's original design let the two mismatch and
    //    caught it after the fact; deriving one from the other removes the
    //    mismatch entirely rather than just detecting it).
    const { data: batch } = await db
      .from("batches").select("id, name, college, fee_amount, status").eq("id", input.batch_id).maybeSingle();
    if (!batch) return fieldError("batch_id", "Pick a batch");

    // 2. The batch's own college must still be real and active — the same
    //    check registration does. A batch's `college` should always resolve
    //    (batches are only ever created against a real, active college), so
    //    this is a defensive check on stale/edited data, not the normal path.
    const { data: college } = await db
      .from("colleges").select("id, name").eq("id", batch.college).eq("active", true).maybeSingle();
    if (!college) return fieldError("batch_id", `${batch.name}'s college (${batch.college}) is not active`);

    // 3. Phone is the login identity and is uniquely indexed three different
    //    ways on profiles. Refuse with a name rather than letting Postgres
    //    throw, so the admin learns WHO already holds the number.
    const { data: existingId } = await db.rpc("find_profile_by_normalized_phone", { p_phone: phone });
    if (existingId) {
      const { data: who } = await db
        .from("profiles").select("full_name, college, is_profile_complete").eq("id", existingId as string).maybeSingle();
      const name = who?.full_name?.trim() || "an existing student";
      return conflict(
        `That number already belongs to ${name}${who?.college ? ` (${who.college})` : ""}. ` +
        `Open them on the roster instead of adding a second record.`,
      );
    }

    if (input.roll_number) {
      const { data: dupRoll } = await db
        .from("profiles").select("id, full_name")
        .eq("roll_number", input.roll_number).eq("college", batch.college).maybeSingle();
      if (dupRoll) return fieldError("roll_number", `Roll number already registered for ${college.name}`);
    }

    // 4. Create the profile.
    const { data: student, error: insertErr } = await db
      .from("profiles")
      .insert({
        full_name: input.full_name,
        phone,
        college: batch.college,
        batch_id: batch.id,
        role: "student",
        // See the header: this is what makes them count as enrolled.
        is_profile_complete: true,
        father_name: input.father_name ?? null,
        roll_number: input.roll_number ?? null,
        branch: input.branch ?? null,
        year: input.year ?? null,
      })
      .select("id, full_name, phone, college, batch_id")
      .single();
    if (insertErr || !student) return dbError("api/admin/students POST", insertErr);

    await audit("student.created_by_admin", "profile", student.id, {
      college: batch.college, batch_id: batch.id, batch_name: batch.name,
      source: "spot_registration", by: user!.profileId,
    });

    // 5. Record the money, if they paid.
    //
    // This is not optional polish. Without an approved payment row a spot
    // student is counted as UNPAID everywhere: item #108 would WhatsApp them a
    // "your classmates are paying" nudge, and the DOCX court exhibit — which
    // lists approved payments only — would file the petition WITHOUT them.
    //
    // It goes in as `submitted` and then through autoApprovePayment, the one
    // funnel every approval path uses, rather than being written straight to
    // `approved`. That funnel is what creates the petition row, writes the
    // payment.approved audit entry, and notifies the student (item #111 found
    // all of this silently skipped for months — do not bypass it).
    let payment: { recorded: boolean; approved: boolean; amount: number | null; error?: string } =
      { recorded: false, approved: false, amount: null };

    if (input.mark_paid) {
      // Rule 4: fee_amount is NUMERIC and arrives as a string.
      const amount = input.amount ?? (batch.fee_amount != null ? Number(batch.fee_amount) : null);
      if (amount == null || !(amount > 0)) {
        payment.error = `${batch.name} has no fee set yet, so the payment was not recorded. Set the batch fee, then record it from the admin Payments page.`;
      } else {
        const { data: pay, error: payErr } = await db
          .from("payments")
          .insert({
            student_id: student.id,
            batch_id: batch.id,
            amount,
            status: "submitted",
            submitted_at: new Date().toISOString(),
            // A distinct method, deliberately NOT `upi_manual`: bank-SMS
            // matching (item #73) is scoped to that value and would try to
            // reconcile cash-at-the-desk against a bank credit forever.
            payment_method: "spot",
            utr_number: input.payment_note ?? null,
            review_notes: `Registered at spot. Recorded by an admin.`,
          })
          .select("id")
          .single();
        if (payErr || !pay) {
          payment.error = "The student was created, but the payment could not be recorded. Record it from the admin Payments page.";
          console.error("[api/admin/students POST] payment insert failed", payErr);
        } else {
          payment = { recorded: true, approved: false, amount };
          const result = await autoApprovePayment(db, pay.id, user!.profileId);
          payment.approved = result.approved;
          if (!result.approved) payment.error = `Payment recorded but not approved: ${result.reason ?? "unknown"}.`;
        }
      }
    }

    return created({ student, batch: { id: batch.id, name: batch.name }, payment });
  } catch (e) {
    console.error("[api/admin/students POST]", e);
    return serverError();
  }
}
