import { SupabaseClient } from "@supabase/supabase-js";
import { fetchCourtCaseStatus, type CourtOrder } from "./court-case";
import { notifyStudent } from "./student-notifications";
import { logSystemError } from "@/lib/system-errors";

/**
 * Court order watch — automatically fetches each tracked batch's writ-petition
 * orders from the Telangana High Court's public case-status portal and sends
 * an IN-APP (push) notification to the batch's students the moment a new
 * order's soft copy appears. Never WhatsApp, never a chat message — the
 * notification opens the order PDF itself. Fully automatic: no approval,
 * no manual checking.
 *
 * Runs once a day from the /api/ping cron (see vercel.json) — piggy-backed
 * there so we don't need a second cron job. A manual trigger exists at
 * /api/cron/court-order-watch (same CRON_SECRET auth as the other cron
 * routes) for the admin to force a check after a hearing.
 *
 * Seen orders are remembered in the existing `app_settings` key-value table
 * (`court_order_watch_seen`), so no new database table or migration is
 * needed — the watcher works the moment it deploys. First run per batch
 * records already-visible orders silently (no notification blast about old
 * orders), except orders from the last SEED_CUTOFF_DAYS — those are the
 * hearings everyone is actually waiting on, so they notify. Every later run
 * notifies only for orders it has never seen before.
 *
 * Fail-soft everywhere: the court endpoint is unofficial and can change
 * without notice. A failed fetch simply means "no new orders detected this
 * run" — never an error the student sees, never a missed-notification retry
 * storm.
 */

const SEEN_KEY = "court_order_watch_seen";
const SEED_CUTOFF_DAYS = 2;

function parseOrderDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDateShort(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** batchId -> ["orderDate|orderUrl", ...] */
type SeenMap = Record<string, string[]>;

async function loadSeen(db: SupabaseClient): Promise<SeenMap> {
  try {
    const { data } = await db.from("app_settings").select("value").eq("key", SEEN_KEY).maybeSingle();
    const raw = (data as { value?: string } | null)?.value;
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") return parsed as SeenMap;
    }
  } catch { /* fail soft — treat as nothing seen */ }
  return {};
}

async function saveSeen(db: SupabaseClient, seen: SeenMap): Promise<void> {
  try {
    await db.from("app_settings").upsert({ key: SEEN_KEY, value: JSON.stringify(seen) });
  } catch { /* fail soft — next run re-checks */ }
}

export interface OrderWatchResult {
  batchesChecked: number;
  newOrders: number;
  studentsNotified: number;
  errors: string[];
}

interface BatchRow {
  id: string;
  slug: string;
  name: string;
  case_type: string | null;
  case_number: string | null;
  case_year: string | null;
}

export async function runCourtOrderWatch(db: SupabaseClient): Promise<OrderWatchResult> {
  const result: OrderWatchResult = { batchesChecked: 0, newOrders: 0, studentsNotified: 0, errors: [] };

  const { data: batches, error } = await db
    .from("batches")
    .select("id, slug, name, case_type, case_number, case_year")
    .not("case_number", "is", null);
  if (error || !batches?.length) return result;

  const seen = await loadSeen(db);
  let seenDirty = false;

  for (const batch of batches as BatchRow[]) {
    result.batchesChecked++;
    try {
      if (await watchBatchOrders(db, batch, seen, result)) seenDirty = true;
    } catch (e) {
      const msg = `${batch.slug}: ${(e as Error)?.message ?? "unknown error"}`;
      result.errors.push(msg);
      try {
        await logSystemError(db, "court-order-watch", e as Error, { batchSlug: batch.slug });
      } catch { /* logging must never break the watch */ }
    }
  }

  if (seenDirty) await saveSeen(db, seen);
  return result;
}

/** Returns true when the seen-map changed and should be persisted. */
async function watchBatchOrders(
  db: SupabaseClient,
  batch: BatchRow,
  seen: SeenMap,
  result: OrderWatchResult
): Promise<boolean> {
  const fresh = await fetchCourtCaseStatus(batch.case_type ?? "", batch.case_number ?? "", batch.case_year ?? "");
  if (!fresh?.orders?.length) return false; // court unreachable or no orders on file — fail soft

  const batchSeen = new Set(seen[batch.id] ?? []);
  const isFirstRun = !(batch.id in seen);
  const cutoff = Date.now() - SEED_CUTOFF_DAYS * 24 * 60 * 60 * 1000;
  let dirty = false;

  for (const order of fresh.orders) {
    const key = `${order.date ?? ""}|${order.url ?? ""}`;
    if (batchSeen.has(key)) continue;

    const orderDate = parseOrderDate(order.date);
    const isRecent = orderDate ? orderDate.getTime() >= cutoff : true;

    // First run: silently record orders older than the cutoff — students
    // could already see those on the case page, so notifying would be noise.
    batchSeen.add(key);
    dirty = true;
    if (isFirstRun && !isRecent) continue;

    const notified = await notifyBatchOfOrder(db, batch, order, orderDate);
    result.newOrders++;
    result.studentsNotified += notified;
  }

  seen[batch.id] = [...batchSeen];
  return dirty;
}

/**
 * Sends the in-app (push-only, never WhatsApp) notification to every student
 * holding a petition in this batch. Returns how many students were notified.
 */
async function notifyBatchOfOrder(
  db: SupabaseClient,
  batch: BatchRow,
  order: CourtOrder,
  orderDate: Date | null
): Promise<number> {
  const { data: petitions } = await db
    .from("petitions")
    .select("student_id")
    .eq("batch_id", batch.id);
  const studentIds = [...new Set((petitions ?? []).map((p) => p.student_id).filter(Boolean))] as string[];
  if (!studentIds.length) return 0;

  const dateStr = orderDate ? formatDateShort(orderDate) : "latest";
  const message =
    `📄 <b>Your court order copy has arrived.</b>\n\n` +
    `The court has published the order dated <b>${dateStr}</b> for your batch's case. ` +
    `Tap to view the soft copy.`;
  // The notification opens the soft copy itself; if the court gave no PDF
  // link, it falls back to the dashboard where the case card lives.
  const url = order.url ?? "/dashboard";
  const referenceId = `court-order-${batch.slug}-${order.date ?? "undated"}`;

  let notified = 0;
  for (const studentId of studentIds) {
    try {
      await notifyStudent(db, studentId, "court_order", message, referenceId, { url });
      notified++;
    } catch (e) {
      console.error("[court-order-watch] notify failed:", batch.slug, studentId, (e as Error)?.message);
    }
  }
  return notified;
}
