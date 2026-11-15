import { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText, sendWhatsAppList, WaMenuRow } from "@/lib/whatsapp/client";

/**
 * Paid-count choosers for the ADMIN path — college, then batch, as tappable
 * WhatsApp list rows instead of asking an admin to type "GNITC Batch 1".
 *
 * Lives in its own module rather than in router.ts because the tap arrives as
 * an interactive selection and is dispatched from admin-menu.ts's
 * handleAdminSelection, which router.ts already imports. Putting it in either
 * of those would make the two import each other.
 *
 * Students never reach any of this — answerPaidCount answers a student with
 * their own batch and returns before the choosers (item #116).
 */

/** WhatsApp caps a list row title at 24 chars and a description at 72. */
const ROW_TITLE_MAX = 24;
const ROW_DESC_MAX = 72;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export const PAID_COUNT_COLLEGE_PREFIX = "adm_pc_col_";
export const PAID_COUNT_BATCH_PREFIX = "adm_pc_b_";
export const PAID_COUNT_ALL_ID = "adm_pc_all";

/**
 * Asks for the WHOLE picture rather than one batch — "paid list", "who has
 * paid", "paid so far".
 *
 * Live-reported: an admin typed "Paid list" and got the student FAQ
 * "Payments are verified automatically... check your UPI app", because this
 * shape matched nothing and fell through to FAQ search. Trigram similarity
 * was only 0.125 (under the 0.25 floor) — it was the SEMANTIC search that
 * matched, so a stricter trigram threshold would not have saved it. Being
 * recognised here is what keeps it out of the FAQ corpus entirely.
 */
export const PAID_LIST_RE =
  /\bpaid\s+(?:list|students?|so\s+far)\b|\blist\s+of\s+(?:paid|payments?)\b|\bpayments?\s+list\b|\bwho\s+(?:has\s+|have\s+)?paid\b/i;

export const wantsAllBatches = (text: string) => PAID_LIST_RE.test(text.trim());

export function batchLabel(college: string, name: string): string {
  const c = String(college ?? "").trim();
  const n = String(name ?? "").trim();
  if (!c) return n;
  return n.toUpperCase().startsWith(c.toUpperCase()) ? n : `${c} ${n}`;
}

export async function getPaidCountForBatch(
  db: SupabaseClient,
  batchId: string,
): Promise<{ paid: number; enrolled: number }> {
  const { data: profiles } = await db
    .from("profiles")
    .select("id")
    .eq("batch_id", batchId)
    .eq("is_profile_complete", true);
  const studentIds = (profiles ?? []).map((p: { id: string }) => p.id);
  if (!studentIds.length) return { paid: 0, enrolled: 0 };
  const { data: approved } = await db
    .from("payments")
    .select("student_id")
    .in("student_id", studentIds)
    .eq("status", "approved");
  const uniquePaid = new Set((approved ?? []).map((p: { student_id: string }) => p.student_id));
  return { paid: uniquePaid.size, enrolled: studentIds.length };
}

interface CountableBatch { id: string; name: string; college: string; enrolled: number }

/**
 * Batches worth offering: real, non-archived, and with at least one REGISTERED
 * student.
 *
 * The empty ones are the reason this filter exists — an admin asking "how many
 * paid" was shown BIET Batch 1 first, which has nobody in it, so tapping it
 * could only ever answer "0 of 0". Enrolment is the item #103 rule
 * (batch_id + is_profile_complete, role-independent), so a batch full of
 * abandoned half-registrations still correctly counts as empty.
 */
export async function countableBatches(db: SupabaseClient): Promise<CountableBatch[]> {
  const { data: batches } = await db
    .from("batches")
    .select("id, name, college")
    .neq("status", "archived")
    .order("college", { ascending: true })
    .order("created_at", { ascending: true });

  const real = (batches ?? []).filter(
    (b: { name: string }) => !/\barchived\s+draft\b/i.test(String(b.name)),
  ) as Array<{ id: string; name: string; college: string }>;
  if (!real.length) return [];

  // One query for every batch's students rather than one per batch.
  const { data: profiles } = await db
    .from("profiles")
    .select("batch_id")
    .in("batch_id", real.map(b => b.id))
    .eq("is_profile_complete", true);

  const enrolledBy = new Map<string, number>();
  for (const p of (profiles ?? []) as Array<{ batch_id: string }>) {
    enrolledBy.set(p.batch_id, (enrolledBy.get(p.batch_id) ?? 0) + 1);
  }

  return real
    .map(b => ({ ...b, enrolled: enrolledBy.get(b.id) ?? 0 }))
    .filter(b => b.enrolled > 0);
}

async function sendBatchRows(
  db: SupabaseClient,
  waFrom: string,
  batches: CountableBatch[],
  bodyText: string,
): Promise<void> {
  // One batch is not a choice — answer it.
  if (batches.length === 1) {
    await sendPaidCountAnswer(db, waFrom, batches[0].id);
    return;
  }
  const rows: WaMenuRow[] = batches.slice(0, 10).map(b => ({
    id: `${PAID_COUNT_BATCH_PREFIX}${b.id}`,
    title: clip(batchLabel(b.college, b.name), ROW_TITLE_MAX),
    description: clip(`${b.enrolled} registered`, ROW_DESC_MAX),
  }));
  await sendWhatsAppList(waFrom, bodyText, "Choose batch", rows);
}

/**
 * Step 1: the colleges that actually have registered students. Skips itself
 * when there is nothing to choose between — one college goes straight to its
 * batches, and a single batch straight to the answer.
 */
export async function sendPaidCountCollegeChoices(db: SupabaseClient, waFrom: string): Promise<void> {
  const batches = await countableBatches(db);
  if (!batches.length) {
    await sendWhatsAppText(waFrom, "No batch has any registered students yet, so there is nothing to count.");
    return;
  }

  const colleges = [...new Set(batches.map(b => b.college))];
  if (colleges.length === 1) {
    await sendBatchRows(db, waFrom, batches, "Which batch?");
    return;
  }

  // "All batches" first: an admin asking "how many paid" usually wants the
  // whole picture, and making them tap through college → batch to get each
  // number one at a time would be worse than the typed list this replaced.
  const rows: WaMenuRow[] = [{
    id: PAID_COUNT_ALL_ID,
    title: "All batches",
    description: clip(`Every batch's count · ${batches.length} with students`, ROW_DESC_MAX),
  }];
  rows.push(...colleges.slice(0, 9).map(college => {
    const own = batches.filter(b => b.college === college);
    const students = own.reduce((n, b) => n + b.enrolled, 0);
    return {
      id: `${PAID_COUNT_COLLEGE_PREFIX}${college}`,
      title: clip(college, ROW_TITLE_MAX),
      description: clip(
        `${own.length} batch${own.length === 1 ? "" : "es"} · ${students} registered`,
        ROW_DESC_MAX,
      ),
    };
  }));
  await sendWhatsAppList(waFrom, "Which college?", "Choose college", rows);
}

/** Step 2: that college's batches. */
export async function sendPaidCountBatchChoices(
  db: SupabaseClient,
  waFrom: string,
  college: string,
): Promise<void> {
  const own = (await countableBatches(db)).filter(
    b => String(b.college).toUpperCase() === college.toUpperCase(),
  );
  if (!own.length) {
    await sendWhatsAppText(waFrom, `No ${college} batch has any registered students yet.`);
    return;
  }
  await sendBatchRows(db, waFrom, own, `Which ${college} batch?`);
}

/** Every countable batch at once — the answer to "paid list". */
export async function sendPaidCountSummary(db: SupabaseClient, waFrom: string): Promise<void> {
  const batches = await countableBatches(db);
  if (!batches.length) {
    await sendWhatsAppText(waFrom, "No batch has any registered students yet, so there is nothing to count.");
    return;
  }
  const lines = await Promise.all(
    batches.map(async b => {
      const { paid, enrolled } = await getPaidCountForBatch(db, b.id);
      return `${batchLabel(b.college, b.name)} — ${paid} of ${enrolled}`;
    }),
  );
  await sendWhatsAppText(waFrom, `*Paid so far*\n\n${lines.join("\n")}`);
}

/** Step 3: the answer for one batch. */
export async function sendPaidCountAnswer(
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
  const { paid, enrolled } = await getPaidCountForBatch(db, batch.id);
  await sendWhatsAppText(
    waFrom,
    `*${batchLabel(batch.college, batch.name)}*\n\n✅ ${paid} of ${enrolled} students have paid and confirmed their seats.`,
  );
}

/**
 * Dispatches a tap on either chooser. Returns false for anything else so the
 * caller's own selection handling is untouched.
 */
export async function handlePaidCountSelection(
  db: SupabaseClient,
  waFrom: string,
  selectionId: string,
): Promise<boolean> {
  if (selectionId === PAID_COUNT_ALL_ID) {
    await sendPaidCountSummary(db, waFrom);
    return true;
  }
  if (selectionId.startsWith(PAID_COUNT_COLLEGE_PREFIX)) {
    await sendPaidCountBatchChoices(db, waFrom, selectionId.slice(PAID_COUNT_COLLEGE_PREFIX.length));
    return true;
  }
  if (selectionId.startsWith(PAID_COUNT_BATCH_PREFIX)) {
    await sendPaidCountAnswer(db, waFrom, selectionId.slice(PAID_COUNT_BATCH_PREFIX.length));
    return true;
  }
  return false;
}
