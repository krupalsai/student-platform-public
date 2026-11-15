import { normalizeToLocalPhone, isValidIndianMobile } from "./phone.ts";
import { maskPhone, type NameMatch } from "./recipient-lookup.ts";

/**
 * Pure text half of the admin student lookup (see student-lookup.ts for
 * the DB half). Deliberately free of `@/` imports and of any I/O, so it
 * runs under plain `node --test` exactly like tests/phone-validation.test.ts
 * — the parser is the part that must never misread an admin's message,
 * so it gets unit tests instead of only a live WhatsApp trial.
 *
 * Regression covered by the parser tests: a student lookup must not fall through
 * to the generic Platform Status totals.
 */

export type LookupTarget =
  | { kind: "phone"; phone: string }
  | { kind: "name"; name: string }
  | { kind: "followup" };

export type ParsedLookup =
  | { kind: "none" }
  | { kind: "lookup"; target: LookupTarget }
  | { kind: "bare-name"; name: string }
  | { kind: "check-usage" };

/** The payment facts the answer shows — the subset of PaymentStatus it needs. */
export interface LookupPayment {
  status: "paid" | "pending" | "failed" | "none";
  amount: number | null;
  paidAt: string | null;
  /** Display label from getPaymentStatus: "Razorpay" | "Cashfree" | "PhonePe" | "in person" | null. */
  gateway?: string | null;
}

/** The profile facts the answer shows — the subset of a profiles row it needs. */
export interface LookupProfile {
  full_name: string | null;
  is_profile_complete: boolean;
  created_at?: string | null;
  batches?: { name?: string | null; college?: string | null } | null;
}

export type LookupResult =
  | { kind: "found"; phone: string; profile: LookupProfile; payment: LookupPayment }
  | { kind: "not-found-phone"; phone: string }
  | { kind: "not-found-name"; name: string }
  | { kind: "ambiguous"; nameQuery: string; matches: NameMatch[] };

const PRONOUN_RE = /^(she|he|they|it)$/i;
const SELF_RE = /^(i|me|my|mine|we|us|our)$/i;

function targetFromText(raw: string): LookupTarget | null {
  const text = raw.trim();
  if (!text) return null;
  if (PRONOUN_RE.test(text)) return { kind: "followup" };
  if (SELF_RE.test(text)) return null;
  // A phone inside the target: spaced "+91 9876543201" as well as plain.
  const phone = extractPhone(text);
  if (phone) return { kind: "phone", phone };
  return { kind: "name", name: text };
}

/**
 * Finds one Indian mobile in free text. The phone must be delimited by a
 * non-digit (or the ends of the message) on both sides, so a 12-digit UTR
 * can never be misread as a 10-digit number starting part-way through it.
 */
export function extractPhone(text: string): string | null {
  const m = text.match(/(?:^|[^\d])(?:\+?91[\s-]?)?([6-9]\d{4})[\s-]?(\d{5})(?!\d)/);
  if (!m) return null;
  const local = normalizeToLocalPhone(`${m[1]}${m[2]}`);
  return isValidIndianMobile(local) ? local : null;
}

function looksLikeName(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
  // Every word starts with a capital AND has a lowercase letter:
  // "Sample Student" yes, "STATUS" / "HELP" no (an all-caps word is
  // a command, not a name — and commands never reach here anyway).
  return words.every((w) => /^[A-Z][A-Za-z'’.—-]*[a-z]$/.test(w));
}

/**
 * Pure: what, if anything, is this admin message asking to look up?
 * Runs last in the admin branch, so anything that is a real command has
 * already been handled — this only claims messages nothing else wanted.
 */
export function parseStudentLookupQuery(raw: string): ParsedLookup {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "none" };
  const clean = text.replace(/[.!?]+$/, "").trim();

  // "CHECK" / "LOOKUP" / "FIND" with nothing after them: usage, not silence.
  if (/^(?:check|lookup|find|look\s*up)$/i.test(clean)) return { kind: "check-usage" };

  // Bare 10-digit number, with or without +91 / spaces / dashes.
  if (/^\+?[\d\s()-]{7,18}$/.test(clean)) {
    const phone = extractPhone(clean);
    if (phone) return { kind: "lookup", target: { kind: "phone", phone } };
  }

  // CHECK / LOOKUP / FIND / STATUS OF / WHO IS <phone or name>
  const cmd = clean.match(/^(?:check|lookup|find|look\s*up|status\s+of|who\s+is)\s+(.+)$/i);
  if (cmd) {
    const target = targetFromText(cmd[1]);
    if (!target) return { kind: "none" };
    return { kind: "lookup", target };
  }

  // "Did Sample Student register?" / "Has 9876543201 paid?" / "Is she registered?"
  const asked = clean.match(
    /^(?:did|has|is|was)\s+(.+?)\s+(?:register|registered|paid|pay|done|completed?|complete)\b/i,
  );
  if (asked) {
    const target = targetFromText(asked[1]);
    if (!target) return { kind: "none" };
    return { kind: "lookup", target };
  }
  // "She registered?" / "They paid?" — pronoun subject, no auxiliary.
  if (/^(she|he|they)\s+(?:registered|paid|done)\b/i.test(clean)) {
    return { kind: "lookup", target: { kind: "followup" } };
  }

  // Number + question in one message: "9876543201 did she register?"
  // (MESSAGE / ADD ADMIN / ANSWER never reach here — handleAdminCommand
  // already claimed them — so a phone here is a lookup, not a relay.)
  if (/\b(?:regist\w*|paid|pay|payment|batch|check|status|who)\b/i.test(clean)) {
    const phone = extractPhone(clean);
    if (phone) return { kind: "lookup", target: { kind: "phone", phone } };
  }

  // Bare full name, exact-match only — resolved against profiles, never
  // guessed. Anything that is not a name-shaped message is left alone.
  if (looksLikeName(clean)) return { kind: "bare-name", name: clean };

  return { kind: "none" };
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function gatewaySuffix(gateway: string | null | undefined): string {
  if (!gateway) return "";
  // "via in person" reads wrong; spot payments are labelled in brackets.
  if (gateway === "in person") return " (in person)";
  return ` via ${gateway}`;
}

function paymentLine(payment: LookupPayment): string {
  const amount =
    payment.amount != null ? ` ₹${Number(payment.amount).toLocaleString("en-IN")}` : "";
  const via = gatewaySuffix(payment.gateway);
  if (payment.status === "paid")
    return `✅ Paid${amount}${payment.paidAt ? ` on ${fmtDate(payment.paidAt)}` : ""}${via}`;
  if (payment.status === "pending")
    return `⏳ Payment pending${amount ? ` —${amount} submitted${via}, waiting for approval` : " — submitted, waiting for approval"}`;
  if (payment.status === "failed") return "❌ Payment failed / rejected — no approved payment";
  return "No payment yet";
}

/** Plain lines, numbers first, no markdown table — the same house style as the RAG answers. */
export function formatLookupAnswer(result: LookupResult): string {
  if (result.kind === "not-found-phone") {
    return (
      `🔍 *+91${result.phone}*\n` +
      `❌ No profile — this number hasn't started registration.\n` +
      `Send them the registration link, or ask them to message the bot.`
    );
  }
  if (result.kind === "not-found-name") {
    return (
      `❌ I couldn't find a student named "*${result.name}*".\n` +
      `Names only match when the student filled their full name during registration — send the 10-digit phone number instead.`
    );
  }
  if (result.kind === "ambiguous") {
    const lines = result.matches
      .map((m) => `• ${m.full_name} (${maskPhone(m.phone)})`)
      .join("\n");
    return (
      `⚠️ More than one student is named *${result.nameQuery}*:\n\n${lines}\n\n` +
      `Resend with the full phone number instead.`
    );
  }

  const { profile, payment, phone } = result;
  const batch = profile.batches ?? null;
  const name = profile.full_name ?? "Name not filled in";
  const header = `🔍 *${name}* (+91${phone})`;
  if (!profile.is_profile_complete) {
    return (
      `${header}\n` +
      `❌ Not registered yet — started but never finished.\n` +
      `• Batch: none — no college/batch chosen\n` +
      `• Payment: ${paymentLine(payment)}\n` +
      `• Profile created: ${fmtDate(profile.created_at)}\n` +
      `They need to finish registration in the Student App.`
    );
  }
  return (
    `${header}\n` +
    `✅ Registered.\n` +
    `• Batch: ${batch?.name ?? "none"}${batch?.college ? ` (${batch.college})` : ""}\n` +
    `• Payment: ${paymentLine(payment)}\n` +
    `• Registered on: ${fmtDate(profile.created_at)}`
  );
}

export const CHECK_USAGE =
  `Send *CHECK <phone or name>* to look up one student.\n` +
  `Example: *CHECK 9876543201*\n\n` +
  `Or just send the 10-digit number on its own.`;

export const FOLLOWUP_NO_CONTEXT =
  `To check one student, send their 10-digit phone number first — e.g. *9876543201* — then ask "did they register?".\n\n` +
  `Or ask in one message: *CHECK 9876543201*.`;
