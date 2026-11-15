import { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { batchLabel, countableBatches } from "@/lib/whatsapp/paid-count";

/**
 * The unpaid list for the ADMIN path — "List all the students who not paid
 * divide by their batches".
 *
 * Live-reported 11 Nov 2026 06:13 IST: Krupal asked the bot exactly that and
 * got "I don't have that information. The admin will reply to your query."
 * Nothing in the router recognised an UNPAID list: the paid-count flow only
 * knows "how many paid" / "paid list", and the grounded answer has no
 * batch-wide list fact, so the question fell through every handler into the
 * fallback. This module is the unpaid mirror of paid-count.ts — same
 * enrolled definition (batch_id + is_profile_complete), same countable
 * batches, same DB-derived college tokens — so the two answers can never
 * disagree about who counts.
 *
 * ADMIN ONLY, by construction: answerUnpaidList is called from the admin
 * branch of router.ts (after getAdmin() recognised the sender), exactly
 * like answerAdminRegistrationStats. The student branch never calls it —
 * a student asking "who hasn't paid" must never see other students' names.
 * There is no student scope here on purpose; do not add one.
 */

/** "list ... not paid" / "list ... unpaid" — the reported shape. */
const LIST_UNPAID_RE =
  /\blist\b.{0,120}?\b(?:not\s+paid|unpaid|haven'?t\s+paid|didn'?t\s+pay)\b/i;
/** "unpaid students" / "unpaid list" / "not paid students". */
const UNPAID_NOUN_RE = /\b(?:unpaid|not\s+paid)\s+(?:students?|list)\b/i;
/** "unpaid in GNITC Batch 2" / "unpaid students in..." — unpaid + a batch word. */
const UNPAID_BATCH_RE = /\bunpaid\b[^.]{0,80}?\b(?:batch|students?|list)\b/i;
/** "GNITC Batch 2 unpaid" — a batch word, then unpaid. */
const BATCH_UNPAID_RE = /\b(?:batch|students?|list)\b[^.]{0,80}?\bunpaid\b/i;
/** "who has not paid" / "who not paid" / "who hasn't paid" / "who didn't pay". */
const WHO_UNPAID_RE =
  /\bwho\s+(?:(?:has|have)\s+)?not\s+paid\b|\bwho\s+(?:hasn'?t|haven'?t|didn'?t)\s+(?:paid|pay)\b/i;

export function isUnpaidListQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    LIST_UNPAID_RE.test(t) ||
    UNPAID_NOUN_RE.test(t) ||
    UNPAID_BATCH_RE.test(t) ||
    BATCH_UNPAID_RE.test(t) ||
    WHO_UNPAID_RE.test(t)
  );
}

export interface UnpaidStudent {
  id: string;
  name: string;
  /** Has a payment row (failed or pending) but no approved one. */
  tried: boolean;
}

/**
 * Registered students in one batch with no approved payment. Mirrors
 * getPaidCountForBatch's enrolled definition, so paid + unpaid always adds
 * up to the enrolled count the paid-count flow reports.
 */
export async function getUnpaidStudentsForBatch(
  db: SupabaseClient,
  batchId: string,
): Promise<UnpaidStudent[]> {
  const { data: profiles } = await db
    .from("profiles")
    .select("id, full_name")
    .eq("batch_id", batchId)
    .eq("is_profile_complete", true);
  const students = (profiles ?? []) as Array<{ id: string; full_name: string | null }>;
  if (!students.length) return [];
  const ids = students.map((s) => s.id);
  const { data: payments } = await db
    .from("payments")
    .select("student_id, status")
    .in("student_id", ids);
  const rows = (payments ?? []) as Array<{ student_id: string; status: string }>;
  const paid = new Set(rows.filter((p) => p.status === "approved").map((p) => p.student_id));
  const attempted = new Set(rows.map((p) => p.student_id));
  return students
    .filter((s) => !paid.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.full_name ?? "(no name)",
      tried: attempted.has(s.id),
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function formatUnpaidNames(unpaid: UnpaidStudent[]): string {
  return unpaid.map((u) => `• ${u.name}${u.tried ? " ⏳" : ""}`).join("\n");
}

/** Every countable batch at once — the answer to "divide by their batches". */
export async function sendUnpaidListSummary(db: SupabaseClient, waFrom: string): Promise<void> {
  const batches = await countableBatches(db);
  if (!batches.length) {
    await sendWhatsAppText(waFrom, "No batch has any registered students yet, so there is nobody to list.");
    return;
  }
  const sections: string[] = [];
  let total = 0;
  for (const b of batches) {
    const unpaid = await getUnpaidStudentsForBatch(db, b.id);
    total += unpaid.length;
    const label = batchLabel(b.college, b.name);
    if (!unpaid.length) {
      sections.push(`*${label}* — all paid ✅`);
      continue;
    }
    sections.push(`*${label}* — ${unpaid.length} not paid\n${formatUnpaidNames(unpaid)}`);
  }
  await sendWhatsAppText(
    waFrom,
    `*Students who have not paid*\n\n${sections.join("\n\n")}\n\n⏳ tried to pay but it did not go through. Total not paid: ${total}.`,
  );
}

/** The answer for one batch. */
export async function sendUnpaidListAnswer(
  db: SupabaseClient,
  waFrom: string,
  batchId: string,
): Promise<void> {
  const { data: batch } = await db
    .from("batches")
    .select("id, name, college")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) {
    await sendWhatsAppText(waFrom, "That batch no longer exists.");
    return;
  }
  const label = batchLabel(batch.college, batch.name);
  // "Everyone has paid" is only true when somebody is actually registered —
  // a batch with nobody in it must say so, not claim a clean sheet.
  const { data: enrolled } = await db
    .from("profiles")
    .select("id")
    .eq("batch_id", batch.id)
    .eq("is_profile_complete", true);
  if (!enrolled?.length) {
    await sendWhatsAppText(waFrom, `*${label}*\n\nNobody is registered in this batch yet.`);
    return;
  }
  const unpaid = await getUnpaidStudentsForBatch(db, batch.id);
  if (!unpaid.length) {
    await sendWhatsAppText(waFrom, `*${label}*\n\nEveryone has paid ✅`);
    return;
  }
  await sendWhatsAppText(
    waFrom,
    `*${label}* — ${unpaid.length} not paid\n\n${formatUnpaidNames(unpaid)}\n\n⏳ tried to pay but it did not go through.`,
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BATCH_NUMBER_RE = /\b(?:batch\s*[-#]?\s*|b\s*)(\d+)\b/i;

interface CountableBatch {
  id: string;
  name: string;
  college: string;
}

const batchNumberOf = (name: string): number | null => {
  const m = String(name).match(/\bbatch\s*(\d+)/i);
  return m ? Number(m[1]) : null;
};

/**
 * Resolves a named batch from the question, if it names one. Colleges come
 * from the live batches themselves (never a hardcoded list), longest first
 * so GNITC is never swallowed by GNIT — the same trap as items #101/#107
 * in the paid-count flow.
 *
 * Resolution runs over ALL live batches, not just the countable ones: a
 * batch with nobody registered yet (BIET Batch 1) is still a real batch,
 * and naming it must answer "nobody is registered" instead of being
 * mistaken for another college's batch with the same number. Returns no
 * batch when the question names none, so the caller answers with the whole
 * picture.
 */
async function liveBatches(db: SupabaseClient): Promise<CountableBatch[]> {
  const { data: batches } = await db
    .from("batches")
    .select("id, name, college")
    .neq("status", "archived")
    .order("college", { ascending: true })
    .order("created_at", { ascending: true });
  return ((batches ?? []) as Array<{ id: string; name: string; college: string }>).filter(
    (b) => !/\barchived\s+draft\b/i.test(String(b.name)),
  );
}

async function resolveUnpaidBatch(
  db: SupabaseClient,
  text: string,
): Promise<{
  batch: CountableBatch | null;
  ambiguous: CountableBatch[];
  noSuch: { college: string; number: number } | null;
}> {
  const batches = await liveBatches(db);
  const colleges = [...new Set(batches.map((b) => b.college))].sort((a, b) => b.length - a.length);
  const collegeRe =
    colleges.length > 0
      ? new RegExp(`\\b(${colleges.map(escapeRe).join("|")})\\b`, "i")
      : null;
  const collegeMatch = collegeRe ? text.match(collegeRe) : null;
  const numberMatch = text.match(BATCH_NUMBER_RE);
  const college = collegeMatch ? collegeMatch[1].toUpperCase() : null;
  const number = numberMatch ? Number(numberMatch[1]) : null;

  // Nothing named at all — the whole picture, not an ambiguity question.
  // ("List all the students who not paid divide by their batches" names
  // no college and no number; asking "which batch?" back would be the
  // same non-answer the bot gave before this module existed.)
  if (!college && number == null) {
    return { batch: null, ambiguous: [], noSuch: null };
  }

  let candidates = batches;
  if (college) candidates = candidates.filter((b) => b.college.toUpperCase() === college);
  if (number != null) candidates = candidates.filter((b) => batchNumberOf(b.name) === number);

  if (college && number != null && candidates.length === 0) {
    return { batch: null, ambiguous: [], noSuch: { college, number } };
  }
  if (candidates.length === 1) return { batch: candidates[0], ambiguous: [], noSuch: null };
  if (candidates.length > 1) return { batch: null, ambiguous: candidates, noSuch: null };
  return { batch: null, ambiguous: [], noSuch: null };
}

function ambiguousUnpaidReply(
  ambiguous: CountableBatch[],
  batchNumber: number | null,
): string {
  const sameNumber =
    batchNumber != null && ambiguous.every((b) => batchNumberOf(b.name) === batchNumber);
  if (sameNumber) {
    const colleges = [...new Set(ambiguous.map((b) => b.college))];
    return `Which college? Batch ${batchNumber} is in more than one college.\n\n${colleges.map((c) => `• ${c}`).join("\n")}\n\nExample: *${colleges[0]} Batch ${batchNumber}*`;
  }
  const names = ambiguous.slice(0, 8).map((b) => `• ${batchLabel(b.college, b.name)}`).join("\n");
  return `Please specify the batch too.\n\n${names}\n\nExample: *${ambiguous[0].college} Batch 1*`;
}

/**
 * Admin-branch dispatcher. Returns false when the message is not an
 * unpaid-list question, so the caller's other handlers run untouched.
 */
export async function answerUnpaidList(
  db: SupabaseClient,
  waFrom: string,
  text: string,
): Promise<boolean> {
  if (!isUnpaidListQuestion(text)) return false;

  const { batch, ambiguous, noSuch } = await resolveUnpaidBatch(db, text);

  if (noSuch) {
    const own = (await liveBatches(db)).filter(
      (b: { college: string }) => b.college.toUpperCase() === noSuch.college,
    );
    const list = own.map((b) => `• ${batchLabel(b.college, b.name)}`).join("\n");
    await sendWhatsAppText(
      waFrom,
      `There's no Batch ${noSuch.number} in ${noSuch.college}.${list ? `\n\nThe batches in ${noSuch.college} are:\n\n${list}` : ""}\n\nExample: *${noSuch.college} Batch 1*`,
    );
    return true;
  }

  if (ambiguous.length) {
    const numberMatch = text.match(BATCH_NUMBER_RE);
    await sendWhatsAppText(
      waFrom,
      ambiguousUnpaidReply(ambiguous, numberMatch ? Number(numberMatch[1]) : null),
    );
    return true;
  }

  if (batch) {
    await sendUnpaidListAnswer(db, waFrom, batch.id);
    return true;
  }

  await sendUnpaidListSummary(db, waFrom);
  return true;
}
