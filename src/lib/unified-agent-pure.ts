/**
 * Unified Agent — pure helpers. No database, no LLM, no imports at all,
 * so these are unit-testable with plain node --test (see
 * tests/unified-agent.test.ts, which imports this file with a .ts
 * extension, the form this repo's runnable tests use).
 *
 * The DB/LLM-backed agent (unified-agent.ts) re-exports everything
 * here, so callers import from one place and tests stay leaf-only.
 */

export type UnifiedChannel = "app" | "whatsapp";

export interface UnifiedActor {
  role: string;
  profileId?: string | null;
  phone?: string | null;
  channel?: UnifiedChannel;
}

/** The snapshot fields formatOwnStatus actually reads. The real
 *  StudentSnapshot (services/student-snapshot) is assignable to this. */
export interface UnifiedStudentSnapshot {
  registrationComplete: boolean;
  batch: { name: string; status: string | null } | null;
  payment: { state: "none" | "approved" | "submitted" | "in_progress" | "failed" | "reupload_requested" | "unknown"; amount: number | null };
  gate: { fee: number | null } | null;
  caseInfo: { number: string | null; status: string | null; nextHearing: string | null } | null;
  openCases: number;
}

/** Admin roles, as used by requireAdmin / admin-copilot. */
export function isAdminRole(role: string | undefined | null): boolean {
  return role === "admin" || role === "super_admin";
}

/** Returns a refusal message, or null when the actor is an admin. */
export function assertUnifiedAdminActor(actor: UnifiedActor): string | null {
  if (!isAdminRole(actor.role)) return "Only admins can perform that action.";
  return null;
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * True when the message is asking about the sender's OWN status, not
 * asking a new help question. Narrow on purpose: "my question is …"
 * (a new question) and "what is the fee" (generic help) are NOT status
 * questions — they go to the FAQ / grounded-LLM path instead.
 */
export function isOwnStatusQuestion(question: string): boolean {
  const q = norm(question);
  if (!q) return false;
  if (q.startsWith("my question") || q.startsWith("my query")) return false;
  if (/^(my status|check my status|my details|show my status|my payment status|my fee|my batch|my case)$/.test(q)) return true;
  if (/\bam i paid\b|\bhave i paid\b|\bdid i pay\b|\bmy payment (is )?(done|complete|approved|pending)\b/.test(q)) return true;
  return /\bmy\b.+\b(fee|payment|batch|case|registration|status)\b/.test(q)
    || /\bmy\b.+\b(paid|registered)\b/.test(q);
}

/** Reduce any Indian mobile to its 10-digit local form (same rule as
 *  whatsapp/phone.ts normalizeToLocalPhone, copied here so this file
 *  stays import-free). */
export function unifiedLocalPhone(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 11) && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** All Indian mobile numbers mentioned in a message, in 10-digit local form. */
export function extractMentionedPhones(question: string): string[] {
  const compact = question.replace(/(?<=\d)[ -](?=\d)/g, "");
  const found = compact.match(/(?<!\d)(?:\+?91)?[6-9]\d{9}(?!\d)/g) ?? [];
  const seen = new Set<string>();
  for (const raw of found) {
    const local = unifiedLocalPhone(raw);
    if (/^[6-9]\d{9}$/.test(local)) seen.add(local);
  }
  return [...seen];
}

/**
 * The first mentioned phone that is NOT one of the sender's own numbers,
 * or null when every mentioned number is the sender's own (or none is
 * mentioned). Returning the number itself is safe: it came from the
 * sender's own message, and no lookup of that number is ever performed.
 */
export function extractOtherStudentPhone(
  question: string,
  ownPhones: ReadonlyArray<string | null | undefined>,
): string | null {
  const own = new Set(
    ownPhones
      .filter((p): p is string => !!p)
      .map((p) => unifiedLocalPhone(p))
      .filter((p) => /^[6-9]\d{9}$/.test(p)),
  );
  for (const mentioned of extractMentionedPhones(question)) {
    if (!own.has(mentioned)) return mentioned;
  }
  return null;
}

function stripRupeeAmounts(text: string): string {
  return text.replace(/ of ₹[\d,.]+/g, "").replace(/₹[\d,.]+/g, "the amount");
}

function describePaymentText(s: UnifiedStudentSnapshot): string {
  switch (s.payment.state) {
    case "approved":
      return `approved${s.payment.amount != null ? ` of ₹${s.payment.amount}` : ""}`;
    case "submitted":
      return `received and waiting for verification${s.payment.amount != null ? ` (₹${s.payment.amount})` : ""}`;
    case "in_progress":
      return "started but not confirmed as completed";
    case "failed":
      return "did not go through — you can pay again from the Payments tab";
    case "reupload_requested":
      return "proof re-upload requested by the team";
    case "none":
      return s.registrationComplete ? "not paid yet" : "not paid yet — complete registration first";
    default:
      return "could not be read right now — the Payments tab shows the live status";
  }
}

/**
 * One short status summary from the student's OWN snapshot only.
 * Fee comes from snapshot.gate.fee (the live batch row) and is only
 * stated when it is still relevant: the student has not already paid
 * and the batch is not closed. On WhatsApp no rupee amount is stated.
 */
export function formatOwnStatus(
  s: UnifiedStudentSnapshot,
  channel: UnifiedChannel = "app",
): string {
  const lines: string[] = [];
  lines.push(`Registration: ${s.registrationComplete ? "complete" : "not complete yet"}`);
  if (s.batch) {
    lines.push(`Batch: ${s.batch.name} (status: ${s.batch.status ?? "unknown"})`);
  } else {
    lines.push("Batch: not assigned yet");
  }
  const paymentText =
    channel === "whatsapp"
      ? stripRupeeAmounts(describePaymentText(s))
      : describePaymentText(s);
  lines.push(`Payment: ${paymentText}`);
  const feeRelevant =
    s.gate?.fee != null && s.payment.state !== "approved" && s.batch?.status !== "closed" && s.batch?.status !== "archived";
  if (feeRelevant) {
    lines.push(
      channel === "whatsapp"
        ? "Batch fee: shown in the Student App Payments tab once announced."
        : `Batch fee (live, set by admin for your batch): ₹${s.gate!.fee}`,
    );
  }
  if (s.caseInfo) {
    lines.push(
      `Court case: ${s.caseInfo.number}${s.caseInfo.status ? `, court status ${s.caseInfo.status}` : ""}${s.caseInfo.nextHearing ? `, next listing ${s.caseInfo.nextHearing}` : ""}`,
    );
  } else if (s.batch) {
    lines.push("Court case: no case number recorded for this batch yet");
  }
  if (s.openCases > 0) {
    lines.push(`Open support cases waiting for the team: ${s.openCases}`);
  }
  return lines.join("\n");
}
