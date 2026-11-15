import type { SupabaseClient } from "@supabase/supabase-js";
import { getStudentProfileRaw } from "@/lib/services/students";
import { getLatestPaymentRaw, type RawLatestPayment } from "@/lib/services/payments";
import { getPaymentGateForBatch, isPetitionMinimumWorthStating, type PaymentGate } from "@/lib/services/payment-gate";
import { disposalMeaning, writtenOrderState } from "@/lib/case-clarity";

/**
 * The in-app assistant's view of ONE student: everything it is allowed to
 * know, read from the database in a handful of queries, plus deterministic
 * "why" explanations computed in code rather than guessed by a model.
 *
 * SECURITY: the only input is `profileId`, which every caller takes from the
 * authenticated session (`requireSession`) — never from the request body or a
 * query string. Nothing here can return another student's data, so a prompt
 * like "show me Rahul's payment status" has nothing to leak even if the model
 * were tricked into trying.
 *
 * Each section is read independently and fails soft: one broken query leaves
 * that section "unknown" instead of failing the whole answer.
 */

export interface StudentSnapshot {
  name: string | null;
  college: string | null;
  registrationComplete: boolean;
  batch: { id: string; name: string; slug: string | null; status: string | null } | null;
  payment: {
    state: "none" | "approved" | "submitted" | "in_progress" | "failed" | "reupload_requested" | "unknown";
    rawStatus: string | null;
    amount: number | null;
    at: string | null;
    reviewNotes: string | null;
  };
  gate: Pick<PaymentGate, "open" | "reason" | "message" | "fee" | "registered" | "required"> | null;
  documents: { collegeIdUploaded: boolean; aiFlag: string | null; reuploadUsed: boolean };
  caseInfo: {
    number: string | null; status: string | null; nextHearing: string | null; checkedAt: string | null;
    /** Set when the court has disposed of the case (dd-mm-yyyy as the court gives it). */
    disposedOn: string | null; disposalType: string | null;
    /** True once the court has published the written order dated the disposal date (with its PDF). */
    finalOrderAvailable: boolean;
  } | null;
  representative: { name: string; phone: string | null } | null;
  announcements: { title: string; urgent: boolean; at: string }[];
  openCases: number;
}

function paymentState(raw: RawLatestPayment | null): StudentSnapshot["payment"]["state"] {
  if (!raw) return "none";
  switch (raw.status) {
    case "approved": return "approved";
    case "submitted": case "pending": return "submitted";
    case "pg_pending": return "in_progress";
    case "rejected": case "pg_failed": return "failed";
    case "reupload_requested": return "reupload_requested";
    default: return "unknown";
  }
}

function daysAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "less than an hour ago";
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export async function buildStudentSnapshot(db: SupabaseClient, profileId: string): Promise<StudentSnapshot> {
  const profile: any = await getStudentProfileRaw(db, profileId).catch(() => null);
  const b = profile?.batches ?? null;
  const batchId: string | null = profile?.batch_id ?? b?.id ?? null;

  const [rawPayment, gate, idRow, caseRow, ann, cases] = await Promise.all([
    getLatestPaymentRaw(db, profileId).catch(() => null),
    batchId ? getPaymentGateForBatch(db, batchId).catch(() => null) : Promise.resolve(null),
    db.from("profiles").select("college_id_path, college_id_ai_flag, college_id_reupload_used")
      .eq("id", profileId).maybeSingle().then((r) => r.data as any, () => null),
    batchId
      ? db.from("batches").select("case_type, case_number, case_year, case_last_status_json, case_status_checked_at")
          .eq("id", batchId).maybeSingle().then((r) => r.data as any, () => null)
      : Promise.resolve(null),
    db.from("announcements").select("title, priority, created_at, college, batch_id, expires_at")
      .order("created_at", { ascending: false }).limit(15).then((r) => (r.data ?? []) as any[], () => []),
    db.from("student_queries").select("id", { count: "exact", head: true })
      .eq("student_id", profileId).eq("status", "pending_admin").then((r) => r.count ?? 0, () => 0),
  ]);

  const nowIso = new Date().toISOString();
  const relevantAnn = ann
    .filter((a) => (!a.expires_at || a.expires_at > nowIso)
      && (!a.batch_id || a.batch_id === batchId)
      && (!a.college || a.college === "all" || a.college === profile?.college))
    .slice(0, 3)
    .map((a) => ({ title: String(a.title ?? ""), urgent: a.priority === "urgent", at: a.created_at }));

  const flag = idRow?.college_id_ai_flag as { isIdCard?: boolean; hasSignature?: boolean; notes?: string } | null;
  let aiFlag: string | null = null;
  if (flag?.isIdCard === false) aiFlag = "the uploaded photo did not look like a college ID card";
  else if (flag?.hasSignature === false) aiFlag = "no student signature was detected on the uploaded ID photo";

  const cs = caseRow?.case_last_status_json as {
    status?: string; listingDate?: string; disposalDate?: string; disposalType?: string;
    orders?: { date?: string | null; type?: string | null; judge?: string | null; url?: string | null }[];
  } | null;
  const disposed = cs?.status === "DISPOSED";
  // The SAME rule the Home screen's tracker uses, so the assistant and the card
  // can never disagree about whether the final order is up. (Order dates arrive
  // as ISO, the disposal date as dd-mm-yyyy — case-clarity matches the two.)
  const finalOrderAvailable = disposed && writtenOrderState({
    status: cs?.status ?? null, listingDate: cs?.listingDate ?? null, filingDate: null, registrationDate: null,
    disposalDate: cs?.disposalDate ?? null, disposalType: cs?.disposalType ?? null, judges: null, purpose: null,
    latestOrder: null, petitionerCount: null,
    orders: (cs?.orders ?? []).map((o) => ({ date: o.date ?? null, type: o.type ?? null, judge: o.judge ?? null, url: o.url ?? null })),
  })?.kind === "published";

  return {
    name: profile?.full_name ?? null,
    college: profile?.college ?? null,
    registrationComplete: !!profile?.is_profile_complete,
    batch: b ? { id: b.id, name: b.name, slug: b.slug ?? null, status: b.status ?? null } : null,
    payment: {
      state: paymentState(rawPayment),
      rawStatus: rawPayment?.status ?? null,
      amount: rawPayment?.amount != null ? Number(rawPayment.amount) : null,
      at: rawPayment?.created_at ?? null,
      reviewNotes: rawPayment?.review_notes ?? null,
    },
    gate: gate ? { open: gate.open, reason: gate.reason, message: gate.message, fee: gate.fee, registered: gate.registered, required: gate.required } : null,
    documents: {
      collegeIdUploaded: !!idRow?.college_id_path,
      aiFlag,
      reuploadUsed: !!idRow?.college_id_reupload_used,
    },
    caseInfo: caseRow?.case_number
      ? {
          number: [caseRow.case_type, caseRow.case_number].filter(Boolean).join(" ") + (caseRow.case_year ? ` / ${caseRow.case_year}` : ""),
          status: cs?.status ?? null,
          // A disposed case has no next hearing; the court still returns the last listing date.
          nextHearing: disposed ? null : cs?.listingDate ?? null,
          checkedAt: caseRow.case_status_checked_at ?? null,
          disposedOn: disposed ? cs?.disposalDate ?? null : null,
          disposalType: disposed ? cs?.disposalType ?? null : null,
          finalOrderAvailable,
        }
      : null,
    representative: b?.representative_name ? { name: b.representative_name, phone: b.representative_phone ?? null } : null,
    announcements: relevantAnn,
    openCases: cases,
  };
}

/** The batch is closed/archived: nobody can pay into it any more. */
export function isBatchOver(s: StudentSnapshot): boolean {
  return s.batch?.status === "closed" || s.batch?.status === "archived";
}

/** One plain sentence about the payment, from data only. */
export function describePayment(s: StudentSnapshot): string {
  const p = s.payment;
  const when = daysAgo(p.at);
  switch (p.state) {
    case "approved": return `Your payment${p.amount ? ` of ₹${p.amount}` : ""} is approved and complete.`;
    case "submitted": return `Your payment${p.amount ? ` of ₹${p.amount}` : ""} was received${when ? ` ${when}` : ""} and is waiting for verification.`;
    case "in_progress": return `A payment attempt was started${when ? ` ${when}` : ""} but the payment page did not confirm it as completed. If money was debited, it is usually confirmed automatically; otherwise you can pay again from the Payments tab.`;
    case "failed": {
      const head = `Your last payment attempt${when ? ` (${when})` : ""} did not go through${p.reviewNotes ? ` — note: ${p.reviewNotes}` : ""}.`;
      // A closed batch takes no payments, so "once payment is open" would promise a retry that never comes.
      if (isBatchOver(s)) return `${head} Your batch is ${s.batch!.status}, so payment can't be retried there — the support team can tell you what applies to you.`;
      return `${head} You can pay again from the Payments tab${s.gate?.open ? "" : " once payment is open"}.`;
    }
    case "reupload_requested": return `The team asked you to re-submit your payment proof${p.reviewNotes ? ` — note: ${p.reviewNotes}` : ""}.`;
    case "none":
      if (!s.registrationComplete) return "You haven't paid yet — complete your registration first.";
      if (s.gate?.open) return "You haven't paid yet, and payment is open for your batch on the Payments tab.";
      return `You haven't paid yet. ${s.gate?.message ?? "Payment isn't open for your batch right now."}`;
    default: return "I couldn't read your payment status right now — the Payments tab shows the live status.";
  }
}

export function describeBatch(s: StudentSnapshot): string {
  if (!s.batch) {
    return s.registrationComplete
      ? "You're registered but not assigned to a batch yet."
      : "You aren't in a batch yet because your registration isn't complete.";
  }
  const status = s.batch.status === "active" ? "open" : s.batch.status ?? "unknown";
  const seats = s.gate ? ` ${s.gate.registered} students are registered so far.` : "";
  return `You're in ${s.batch.name} (status: ${status}).${seats}`;
}

/**
 * The STUDENT CONTEXT block handed to the model. Plain labelled lines plus
 * code-computed explanations, so the model explains real state instead of
 * inferring it. Never includes another student's data (there is none to include).
 */
export function snapshotToFacts(s: StudentSnapshot, opts: { hideAmounts?: boolean } = {}): string {
  const lines: string[] = [];
  // WhatsApp (rule 8): no rupee amount may reach the model there at all.
  const amounts = (t: string) => (opts.hideAmounts ? t.replace(/ of ₹[\d,.]+/g, "") : t);
  if (s.name) lines.push(`Name: ${s.name}`);
  if (s.college) lines.push(`College: ${s.college}`);
  lines.push(`Registration complete: ${s.registrationComplete ? "yes" : "no"}`);
  lines.push(`Batch: ${s.batch ? `${s.batch.name} (status ${s.batch.status ?? "unknown"})` : "none assigned"}`);
  if (s.gate) {
    // A student who has not paid in a closed batch cannot pay: say so outright. The
    // generic gate message ("not currently accepting payments") made the model
    // improvise "payment isn't open YET ... you'll get the Route Map after you pay"
    // (live check, 2026-10-12) — a promise nobody can keep.
    const unpaidInClosedBatch = isBatchOver(s) && s.payment.state !== "approved";
    lines.push(`Payment open for this batch: ${s.gate.open ? "yes" : unpaidInClosedBatch
      ? `no — the batch is ${s.batch?.status} and takes no new payments. Do not tell this student to pay or that payment will open later; the support team can tell them what applies to them`
      : `no (${s.gate.message ?? s.gate.reason})`}`);
    // The batch's CURRENT fee is only worth stating to someone who can still
    // pay it. After approval it is not what they paid, and in a closed batch
    // nobody can pay — quoting it made the assistant tell a student who paid
    // ₹2,200 that "the fee is ₹1,100" (real thread, 2026-10-09).
    const feeRelevant = s.payment.state !== "approved" && !isBatchOver(s);
    if (s.gate.fee != null && feeRelevant) lines.push(opts.hideAmounts ? "Batch fee: set by admin (the amount is shown in the Student App only — never state it on WhatsApp)" : `Batch fee (set by admin): ₹${s.gate.fee}`);
    // The petition minimum is about FORMING a batch. Once the batch is closed or
    // a case is on file it only misleads ("the petition still needs more students"),
    // and a minimum of 1 says nothing at all.
    const minimumNote = isBatchOver(s) || s.caseInfo || !isPetitionMinimumWorthStating(s.gate.required) ? "" : ` (petition minimum ${s.gate.required})`;
    lines.push(`Registered students in batch: ${s.gate.registered}${minimumNote}`);
  }
  lines.push(`Payment: ${amounts(describePayment(s))} [raw status: ${s.payment.rawStatus ?? "none"}]`);
  lines.push(`College ID photo: ${s.documents.collegeIdUploaded ? "uploaded" : "not uploaded"}${s.documents.aiFlag ? ` — automatic check: ${s.documents.aiFlag}` : ""}${s.documents.reuploadUsed ? " (one-time re-upload already used)" : ""}`);
  if (s.caseInfo) {
    lines.push(`Court case: ${s.caseInfo.number}${s.caseInfo.status ? `, court status ${s.caseInfo.status}` : ""}${s.caseInfo.nextHearing ? `, next listing ${s.caseInfo.nextHearing}` : ""} (shown on the Home screen)`);
    if (s.caseInfo.disposedOn) lines.push(`Court case outcome: ${caseOutcomeLine(s.caseInfo)}`);
  } else if (s.batch) {
    lines.push("Court case: no case number recorded for this batch yet");
  }
  if (s.representative) lines.push(`Batch representative (receives the Court Order hard copy): ${s.representative.name}`);
  if (s.announcements.length) {
    lines.push(`Recent announcements: ${s.announcements.map((a) => `${a.urgent ? "[urgent] " : ""}${a.title}`).join("; ")}`);
  }
  if (s.openCases) lines.push(`Open support cases waiting for the team: ${s.openCases}`);

  // Deterministic reasoning the model should relay, not re-derive.
  const why: string[] = [];
  if (!s.registrationComplete) why.push("Nothing else (batch, payment, Route Map) can progress until registration is complete.");
  if (s.registrationComplete && s.payment.state === "submitted") why.push("Registration is done; the only pending step is payment verification.");
  if (s.registrationComplete && s.payment.state === "none" && s.gate && !s.gate.open) why.push(`Payment is not possible yet: ${s.gate.message ?? s.gate.reason}.`);
  if (s.payment.state === "approved") why.push("Payment is complete; the Route Map on the Batch tab shows the certificate steps.");
  if (s.documents.aiFlag) why.push("The College ID photo may need re-uploading from the Profile tab.");
  if (why.length) lines.push(`What this means: ${why.join(" ")}`);
  return lines.join("\n");
}

/**
 * Plain facts about a disposed case and its final order copy — from the court
 * portal's own data only. Never a date for when the court will upload, and never
 * a win the label does not say: only "ALLOWED" means the petition succeeded,
 * while "DISPOSED OF NO COSTS" does not say who won (case-clarity.ts words each).
 */
export function caseOutcomeLine(c: NonNullable<StudentSnapshot["caseInfo"]>): string {
  const meaning = disposalMeaning(c.disposalType);
  const copy = c.finalOrderAvailable
    ? "The final order copy is on the court portal and can be opened under Orders & Judgments in the court case card on the Home screen."
    : "The court has not uploaded the final order copy to its website yet. It appears automatically under Orders & Judgments in the court case card on the Home screen as soon as the court uploads it (the app checks every hour). The app cannot say when the court will upload it.";
  return `Disposed on ${c.disposedOn}${c.disposalType ? ` (${c.disposalType})` : ""}.${meaning ? ` ${meaning}` : ""} ${copy}`;
}

/**
 * The deterministic answer to "what is the status/result of our case?" — the
 * Support menu's "Court case status" and every outcome-style question use it,
 * and it replaces any model reply that claims an outcome the record doesn't show.
 */
export function caseStatusText(c: StudentSnapshot["caseInfo"]): string {
  if (!c) return "No court case number has been recorded for your batch yet. It will appear on your Home screen as soon as the lawyer files the petition.";
  const parts = [`Your batch's case is ${c.number}.`];
  if (c.status) parts.push(`Court status: ${c.status}.`);
  if (c.disposedOn) parts.push(caseOutcomeLine(c));
  else if (c.nextHearing) parts.push(`Next listing: ${c.nextHearing}.`);
  if (!c.disposedOn) parts.push("The full tracker, orders and live updates are on your Home screen.");
  return parts.join(" ");
}
