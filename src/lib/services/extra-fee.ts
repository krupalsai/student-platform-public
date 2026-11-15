import { SupabaseClient } from "@supabase/supabase-js";
import { fetchRazorpayOrderPayments } from "@/lib/razorpay";

/**
 * The batch's second, separate charge (e.g. ₹200 after the main ₹2,000).
 *
 * Lives in its own table (`extra_fee_payments`) so nothing that reads
 * `payments` — paid counts, the court exhibit, approvals, batch notices —
 * changes because of it. "Paid" for the petition still means the main fee.
 *
 * The split exists for ONE reason: dodging the government's 0.4% UPI charge on
 * P2M payments above ₹2,000. It opens only while that charge is live (THE CHECK:
 * UPI_MDR_ACTIVE below) AND the student's total fee crosses ₹2,000 — otherwise
 * students simply pay the single batch fee.
 */

export const DEFAULT_EXTRA_FEE_LABEL = "Second payment";
export const DEFAULT_EXTRA_FEE_NOTE =
  "UPI payments above ₹2,000 carry an extra 0.4% government charge. To avoid it, your fee is split into two separate payments, each at or under that limit. This one opens after your batch fee is approved.";

/** Fallback opening date if an admin never switches item 2 on early. */
export const DEFAULT_EXTRA_FEE_STARTS_AT = "2026-10-15T00:00:00+05:30";

/**
 * THE CHECK — is the government actually charging the UPI MDR right now?
 *
 * NPCI's 0.4% charge on P2M UPI payments above ₹2,000 was DEFERRED (official
 * press note, 13 Oct 2026 — new date "immediately post Diwali", TBA). While this
 * is false, the two-payment split stays off for everyone and students pay the
 * single batch fee. (Replaces the 2026-10-14 kill switch.)
 *
 * Flip to true the day NPCI enforces the charge. The split then opens BY ITSELF —
 * but only for batches whose total fee (item 1 + item 2) exceeds ₹2,000: below
 * that, no single transaction can attract the charge, so splitting would be
 * pointless. An admin can still force it open early per batch via
 * extra_fee_enabled, which bypasses this check.
 */
export const UPI_MDR_ACTIVE = false;

/** Per-transaction MDR threshold. The split only matters above ₹2,000. */
export const UPI_MDR_THRESHOLD = 2000;


/** Item 2 is open when an admin switched it on early, or its start date has passed. */
export function isExtraFeeOpen(
  batch: { extra_fee_enabled?: boolean | null; extra_fee_starts_at?: string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (batch?.extra_fee_enabled) return true;
  const start = batch?.extra_fee_starts_at ? Date.parse(batch.extra_fee_starts_at) : NaN;
  return Number.isFinite(start) && now.getTime() >= start;
}

export interface ExtraFeeState {
  /** The admin has switched this on for the student's batch and it applies to them. */
  applies: boolean;
  /** Applies and not yet paid — the student has something to do. */
  due: boolean;
  paid: boolean;
  amount: number | null;
  label: string;
  note: string;
  paidAt: string | null;
  /** When item 2 opens by itself (ISO), if a date is set. */
  opensAt: string | null;
  /**
   * Where this item sits in the student's two-item order:
   * paid · due (pay now) · later (on the order, not payable yet) · none (not on the order).
   */
  status: "paid" | "due" | "later" | "none";
  /** Why it does not apply, for the UI (never shown verbatim to students). */
  reason?: "off" | "no_batch" | "main_not_paid" | "paid_in_full_earlier";
}

const OFF: ExtraFeeState = {
  applies: false, due: false, paid: false, amount: null,
  label: DEFAULT_EXTRA_FEE_LABEL, note: DEFAULT_EXTRA_FEE_NOTE, paidAt: null, opensAt: null, status: "none",
};

export async function getExtraFeeState(db: SupabaseClient, studentId: string): Promise<ExtraFeeState & { batchId?: string }> {
  const { data: profile } = await db.from("profiles").select("batch_id").eq("id", studentId).maybeSingle();
  if (!profile?.batch_id) return { ...OFF, reason: "no_batch" };

  const { data: batch } = await db.from("batches")
    .select("id, status, fee_amount, extra_fee_amount, extra_fee_label, extra_fee_note, extra_fee_enabled, extra_fee_starts_at")
    .eq("id", profile.batch_id).maybeSingle();
  const amount = Number(batch?.extra_fee_amount ?? 0);
  const base = {
    ...OFF,
    amount: amount > 0 ? amount : null,
    label: batch?.extra_fee_label?.trim() || DEFAULT_EXTRA_FEE_LABEL,
    note: batch?.extra_fee_note?.trim() || DEFAULT_EXTRA_FEE_NOTE,
    opensAt: batch?.extra_fee_starts_at ?? null,
    batchId: batch?.id,
  };

  const { data: paidRow } = await db.from("extra_fee_payments")
    .select("paid_at").eq("student_id", studentId).eq("batch_id", profile.batch_id).eq("status", "paid").maybeSingle();
  if (paidRow) return { ...base, applies: true, paid: true, due: false, paidAt: paidRow.paid_at, status: "paid" };

  if (!(amount > 0)) return { ...base, reason: "off" };

  // THE CHECK, applied: no government charge → no split, whatever the dates say.
  // An admin forcing extra_fee_enabled on the batch bypasses the check.
  // The ₹2,000 test is on the TOTAL fee: the split only dodges the charge when a
  // single transaction could cross the MDR threshold.
  if (!batch?.extra_fee_enabled) {
    if (!UPI_MDR_ACTIVE) return { ...base, reason: "off" };
    if (!(Number(batch?.fee_amount ?? 0) + amount > UPI_MDR_THRESHOLD)) return { ...base, reason: "off" };
  }

  const { data: main } = await db.from("payments")
    .select("amount").eq("student_id", studentId).eq("status", "approved")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  // Students who paid the old full amount (e.g. ₹2,200 in one go) owe nothing more.
  if (main && Number(main.amount) >= Number(batch?.fee_amount ?? 0) + amount) {
    return { ...base, reason: "paid_in_full_earlier" };
  }

  // A batch that takes no payments (closed, archived, paused, full…) can't take
  // item 1 either (payment-gate.ts: only an active batch is open), so a student
  // who hasn't paid it has no order to complete. Without this, every such batch
  // that carries a second-payment amount shows its unpaid students "Pay below /
  // After item 1" for an order that can never open (2026-10-12: all batches got
  // the amount in a bulk update, 18 unpaid students sit in the closed GNITC
  // Batch 1). Students who DID pay item 1 are unaffected.
  if (!main && batch?.status !== "active") return { ...base, reason: "off" };

  // On the order but not payable yet: its start date hasn't come (and no admin
  // opened it early), or the main fee isn't approved yet.
  if (!isExtraFeeOpen(batch)) return { ...base, reason: "off", status: "later" };
  if (!main) return { ...base, reason: "main_not_paid", status: "later" };

  return { ...base, applies: true, due: true, status: "due" };
}

/**
 * Marks an extra-fee order paid after checking the captured amount.
 * Idempotent: an already-paid row stays paid. Returns the final status.
 */
export async function settleExtraFeeOrder(
  db: SupabaseClient,
  row: { id: string; amount: number | string; status: string },
  captured: { paymentId: string; amountPaise: number; utr?: string | null },
): Promise<"paid" | "failed" | "already_paid"> {
  if (row.status === "paid") return "already_paid";
  const expected = Math.round(Number(row.amount) * 100);
  if (captured.amountPaise !== expected) {
    await db.from("extra_fee_payments").update({ status: "failed", razorpay_payment_id: captured.paymentId })
      .eq("id", row.id).neq("status", "paid");
    console.error(`[extra-fee] amount mismatch on ${row.id}: expected ${expected}p, got ${captured.amountPaise}p`);
    return "failed";
  }
  const { data } = await db.from("extra_fee_payments").update({
    status: "paid",
    razorpay_payment_id: captured.paymentId,
    utr: captured.utr || captured.paymentId,
    paid_at: new Date().toISOString(),
  }).eq("id", row.id).neq("status", "paid").select("id");
  return data && data.length > 0 ? "paid" : "already_paid";
}

/** Re-checks the student's unsettled extra-fee orders with Razorpay (callback lost, browser closed). */
export async function reconcileExtraFeeOrders(db: SupabaseClient, studentId: string): Promise<void> {
  const { data: rows } = await db.from("extra_fee_payments")
    .select("id, amount, status, razorpay_order_id")
    .eq("student_id", studentId).eq("status", "pending")
    .order("created_at", { ascending: false }).limit(5);
  for (const row of rows ?? []) {
    if (!row.razorpay_order_id) continue;
    try {
      const list = await fetchRazorpayOrderPayments(row.razorpay_order_id);
      const cap = list.items.find((p) => p.status === "captured" || p.captured);
      if (!cap) continue;
      await settleExtraFeeOrder(db, row, {
        paymentId: cap.id,
        amountPaise: Number(cap.amount),
        utr: cap.acquirer_data?.rrn ?? cap.acquirer_data?.bank_transaction_id ?? null,
      });
    } catch (e) {
      console.error("[extra-fee] reconcile failed", row.id, e);
    }
  }
}
