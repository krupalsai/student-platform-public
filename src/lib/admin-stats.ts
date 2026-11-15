import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared, deterministic admin statistics for BOTH admin surfaces — the
 * WhatsApp bot (router.ts admin branch) and the in-app Admin Copilot
 * (/api/admin/copilot) — so a stats question gets the same short answer,
 * with the same numbers, on either surface, without depending on any LLM.
 *
 * Why this exists (live failures, 2026-10-22): the owner asked the
 * WhatsApp bot "New registrations" and got the STUDENT registration flow
 * (the text fell past every deterministic admin handler into the grounded
 * LLM); "How many registration done today" got the all-time STATUS totals
 * (no day filter existed); and the in-app copilot buried the real answer
 * ("Today: 0 registrations") as the 4th bullet of a fallback snapshot
 * after its whole LLM provider chain degraded.
 *
 * ONE student definition everywhere — the platform's enrolment rule
 * (item #103, also used by paid-count denominators and seat counts):
 * a student counts when their profile is complete AND they belong to a
 * batch (batch_id IS NOT NULL AND is_profile_complete = true),
 * role-independent — a staff account that is itself enrolled counts, an
 * incomplete signup, or a complete profile with no batch, does not.
 * Before this module the in-app snapshot counted raw role='student' rows
 * instead (213 total / 96 complete vs WhatsApp's 101 enrolled), so the
 * two surfaces disagreed about the same platform. Verified against the
 * live DB on 2026-10-22: enrolled = 101, role='student' rows = 213,
 * role='student' + complete = 96, payments approved = 59 on both.
 */

export type StatsDay = "today" | "yesterday" | "total";

const REGIST_RE = /\bregist\w*/;

/**
 * Registration-count questions an admin asks: "New registrations",
 * "How many registration done today", "registrations yesterday",
 * "total registrations", "registration count". Returns null for
 * anything else — in particular "registration status" (a status
 * workflow, not a count) and every payment question. Pure; no I/O.
 */
export function parseRegStatsQuery(raw: string): { day: StatsDay } | null {
  const t = (raw ?? "").toLowerCase().trim().replace(/[.!?]+$/, "");
  if (!REGIST_RE.test(t)) return null;
  const bare = /^(new\s+)?registrations?$/.test(t);
  const hasDay = /\b(today|yesterday)\b/.test(t);
  const hasCue =
    bare || hasDay || /\bnew\b/.test(t) ||
    /\b(how many|count|total|number of|no of|so far)\b/.test(t);
  if (!hasCue) return null;
  if (/\ball[-\s]?time\b/.test(t) || /\boverall\b/.test(t) || /\bso\s+far\b/.test(t)) return { day: "total" };
  if (/\btotal\b/.test(t) && !hasDay) return { day: "total" };
  if (/\byesterday\b/.test(t)) return { day: "yesterday" };
  return { day: "today" };
}

/**
 * A message that is ONLY a day word — the follow-up an admin sends right
 * after a stats answer ("Today" / "Yesterday"). Callers must only honour
 * it when the sender's previous intent was a stats query (see the
 * ADMIN_REG_STATS last-intent marker in router.ts).
 */
export function parseBareDayWord(raw: string): "today" | "yesterday" | null {
  const t = (raw ?? "").toLowerCase().trim().replace(/[.!?]+$/, "");
  if (t === "today") return "today";
  if (t === "yesterday") return "yesterday";
  return null;
}

// ── IST day ranges ────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** [start, end) UTC instants bounding one IST calendar day, plus its "22 Oct" label. */
export function istDayRange(day: "today" | "yesterday"): { startIso: string; endIso: string; label: string } {
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const startUtcMs =
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) -
    IST_OFFSET_MS -
    (day === "yesterday" ? 86400000 : 0);
  const istDate = new Date(startUtcMs + IST_OFFSET_MS);
  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(startUtcMs + 86400000).toISOString(),
    label: `${istDate.getUTCDate()} ${MONTHS[istDate.getUTCMonth()]}`,
  };
}

// ── Live counts ───────────────────────────────────────────────────────

export interface DayStats {
  registrations: number;
  paymentsReceived: number;
  paymentsApproved: number;
  collectedApproved: number;
}

/** Day-scoped counts: new enrolled registrations created that IST day,
 *  payments received that day, and payments approved that day
 *  (status approved + reviewed_at in range — the snapshot's definition).
 *  "Received" means money actually arrived at the gateway — status
 *  submitted or approved only. A pg_pending row is just an opened
 *  checkout that was never paid, and pg_failed never arrived, so neither
 *  counts as received (12 Nov 2026: the test account's pg_pending
 *  checkout made "Payments received" read 1 on a day with no real
 *  payment). */
export async function getDayStats(db: SupabaseClient, day: "today" | "yesterday"): Promise<DayStats> {
  const { startIso, endIso } = istDayRange(day);
  const [reg, received, approvedRows] = await Promise.all([
    db.from("profiles").select("id", { count: "exact", head: true })
      .not("batch_id", "is", null).eq("is_profile_complete", true)
      .gte("created_at", startIso).lt("created_at", endIso),
    db.from("payments").select("id", { count: "exact", head: true })
      .in("status", ["submitted", "approved"])
      .gte("created_at", startIso).lt("created_at", endIso),
    db.from("payments").select("amount")
      .eq("status", "approved").gte("reviewed_at", startIso).lt("reviewed_at", endIso),
  ]);
  const approved = approvedRows.data ?? [];
  return {
    registrations: reg.count ?? 0,
    paymentsReceived: received.count ?? 0,
    paymentsApproved: approved.length,
    collectedApproved: approved.reduce((s: number, p: { amount: unknown }) => s + Number(p.amount ?? 0), 0),
  };
}

/** THE student total: enrolled = batch_id NOT NULL + profile complete, any role. */
export async function getEnrolledStudentTotal(db: SupabaseClient): Promise<number> {
  const { count } = await db.from("profiles")
    .select("id", { count: "exact", head: true })
    .not("batch_id", "is", null).eq("is_profile_complete", true);
  return count ?? 0;
}

export interface PlatformTotals {
  students: number;
  pendingPayments: number;
  approvedPayments: number;
  activeBatches: number;
}

/** All-time totals — identical queries to the WhatsApp STATUS command in
 *  admin.ts, so the "total" answer matches on both surfaces. */
export async function getPlatformTotals(db: SupabaseClient): Promise<PlatformTotals> {
  const [students, pending, approved, batches] = await Promise.all([
    getEnrolledStudentTotal(db),
    db.from("payments").select("id", { count: "exact", head: true }).eq("status", "submitted"),
    db.from("payments").select("id", { count: "exact", head: true }).eq("status", "approved"),
    db.from("batches").select("id", { count: "exact", head: true }).eq("status", "active"),
  ]);
  return {
    students,
    pendingPayments: pending.count ?? 0,
    approvedPayments: approved.count ?? 0,
    activeBatches: batches.count ?? 0,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * The day answer, day number FIRST (the failure mode this fixes was the
 * day count buried inside a totals wall). `bold` wraps the headline in
 * WhatsApp markdown; the in-app chat renders plain text.
 */
export function formatDayStats(
  day: "today" | "yesterday",
  stats: DayStats,
  enrolledTotal: number,
  bold: boolean,
): string {
  const { label } = istDayRange(day);
  const headline = `Registrations ${day} (${label}): ${stats.registrations}`;
  const inr = `₹${stats.collectedApproved.toLocaleString("en-IN")}`;
  return [
    bold ? `*${headline}*` : headline,
    `Payments received: ${stats.paymentsReceived} · Approved: ${stats.paymentsApproved} (${inr})`,
    `Students (total enrolled): ${enrolledTotal}`,
  ].join("\n");
}
