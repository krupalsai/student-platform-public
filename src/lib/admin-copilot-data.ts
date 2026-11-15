import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminSnapshot } from "./admin-copilot";
import { normalizePhone } from "./services/students";
import { getCollegeName } from "./services/colleges";

/**
 * Admin Copilot — the READ-ONLY data verbs behind the agent loop
 * (`admin-copilot-loop.ts`) and the deterministic fast path in
 * `/api/admin/copilot`.
 *
 * Every function here only SELECTs. Writes never happen in this module —
 * the model proposes those through `propose_action` and they land in
 * `admin-copilot-agent.ts` behind the admin's one-tap confirmation.
 *
 * Queries deliberately fetch broad and filter/aggregate in JS, the same
 * pattern as getAdminSnapshot(): the data set is a few hundred rows, and
 * keeping the filtering in JS keeps every function testable with a dumb
 * chainable fake (see tests/tests/admin-copilot-tools.test.ts).
 */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** IST (UTC+5:30) midnight as a UTC instant, for "today" filters. */
function istTodayStartIso(): string {
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  return new Date(istMidnight - IST_OFFSET_MS).toISOString();
}

function inr(n: unknown): string {
  return `₹${Number(n ?? 0).toLocaleString("en-IN")}`;
}

/** "today" / "1 day old" / "4 days old" against an ISO timestamp. */
function ageLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

function istNowLabel(): string {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

/* ── shared fetches ─────────────────────────────────────────────── */

interface ProfileRow {
  id: string; full_name: string | null; phone: string | null; roll_number: string | null;
  college: string | null; branch: string | null; year: string | null;
  batch_id: string | null; is_profile_complete: boolean | null; created_at: string | null;
  college_id_path: string | null; college_id_ai_flag: { hasSignature?: boolean } | null;
}
interface PaymentRow {
  id: string; status: string; amount: number | null; created_at: string | null;
  reviewed_at: string | null; student_id: string | null; batch_id: string | null; utr_number: string | null;
}
interface BatchRow {
  id: string; name: string; college: string; status: string; fee_amount: number | null;
  batch_limit: number | null; upi_id: string | null; whatsapp_group_link: string | null;
}

async function fetchProfiles(db: SupabaseClient): Promise<ProfileRow[]> {
  const { data, error } = await db.from("profiles").select("id, full_name, phone, roll_number, college, branch, year, batch_id, is_profile_complete, created_at, college_id_path, college_id_ai_flag").eq("role", "student");
  if (error) throw new Error("Could not read profiles; live data is unavailable.");
  return (data ?? []) as ProfileRow[];
}
async function fetchPayments(db: SupabaseClient): Promise<PaymentRow[]> {
  const { data, error } = await db.from("payments").select("id, status, amount, created_at, reviewed_at, student_id, batch_id, utr_number");
  if (error) throw new Error("Could not read payments; live data is unavailable.");
  return (data ?? []) as PaymentRow[];
}
async function fetchBatches(db: SupabaseClient): Promise<BatchRow[]> {
  const { data, error } = await db.from("batches").select("id, name, college, status, fee_amount, batch_limit, upi_id, whatsapp_group_link").neq("status", "archived");
  if (error) throw new Error("Could not read batches; live data is unavailable.");
  return (data ?? []) as BatchRow[];
}

/** Resolve a free-text batch reference ("gnit batch 2", "batch 1", "GNITC") to batches, in JS. */
function matchBatches(batches: BatchRow[], ref: string | undefined): BatchRow[] {
  const r = (ref ?? "").trim().toLowerCase();
  if (!r) return batches;
  const num = r.match(/(\d+)/)?.[1];
  const college = r.includes("gnitc") ? "gnitc" : r.includes("gnit") ? "gnit" : r.includes("biet") ? "biet" : null;
  return batches.filter(b => {
    if (college && b.college.toLowerCase() !== college) return false;
    if (num && !(b.name.toLowerCase().includes(`batch ${num}`) || b.name.toLowerCase().includes(`batch ${Number(num)}`))) return false;
    if (!college && !num) return b.name.toLowerCase().includes(r) || b.college.toLowerCase() === r;
    return true;
  });
}

/* ── 1. Briefing ────────────────────────────────────────────────── */

export interface Briefing {
  atLabel: string;
  attention: string[];
  todayLine: string;
  totalsLine: string;
  batchesLine: string;
}

export async function getBriefing(db: SupabaseClient): Promise<Briefing> {
  const [snapshot, payments, profiles] = await Promise.all([getAdminSnapshot(db), fetchPayments(db), fetchProfiles(db)]);
  const attention: string[] = [];

  const reviewable = payments
    .filter(p => ["submitted", "reupload_requested"].includes(p.status))
    .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));
  if (reviewable.length) {
    attention.push(`${reviewable.length} payment${reviewable.length === 1 ? "" : "s"} waiting for review — oldest is ${ageLabel(reviewable[0].created_at)}`);
  }

  const noFee = snapshot.batches.filter(b => b.status === "active" && (!b.fee || b.fee <= 0));
  for (const b of noFee) attention.push(`${b.name} has no fee set — students in it cannot pay yet`);

  const missingSigs = profiles.filter(p => p.college_id_path && p.college_id_ai_flag?.hasSignature === false).length;
  if (missingSigs) attention.push(`${missingSigs} verified College ID${missingSigs === 1 ? "" : "s"} missing the student signature`);

  if (snapshot.pendingUnknownQuestions) {
    attention.push(`${snapshot.pendingUnknownQuestions} student question${snapshot.pendingUnknownQuestions === 1 ? "" : "s"} waiting for an answer`);
  }

  // One grouped line, not one bullet per college: six colleges with one
  // student each used to fill the whole briefing with near-identical lines.
  // College ids (e.g. AICTE numbers) resolve to real names where the
  // college directory knows them, and fall back to the raw id.
  const waiting = snapshot.waitlistByCollege.filter(w => w.waiting > 0);
  if (waiting.length) {
    const totalWaiting = waiting.reduce((sum, w) => sum + w.waiting, 0);
    if (waiting.length === 1) {
      const name = await getCollegeName(db, waiting[0].college);
      attention.push(`${totalWaiting} student${totalWaiting === 1 ? "" : "s"} on the ${name} waitlist`);
    } else {
      const parts: string[] = [];
      for (const w of waiting) {
        const name = await getCollegeName(db, w.college);
        parts.push(`${name} (${w.waiting})`);
      }
      attention.push(`${totalWaiting} students on waitlists (${waiting.length} colleges): ${parts.join(", ")}`);
    }
  }

  // One batch per line, biggest first — the old single run-on line buried
  // the real batches among empty and demo ones.
  const batchLines = [...snapshot.batches]
    .sort((a, b) => b.enrolled - a.enrolled)
    .map(b => `• ${b.name} — ${b.enrolled} enrolled · ${b.fee && b.fee > 0 ? `fee ${inr(b.fee)}` : "no fee set"}`);

  return {
    atLabel: istNowLabel(),
    attention,
    todayLine: `Today so far: ${snapshot.today.registrations} registration${snapshot.today.registrations === 1 ? "" : "s"} · ${snapshot.today.approvedPayments} payment${snapshot.today.approvedPayments === 1 ? "" : "s"} approved (${inr(snapshot.today.collected)})`,
    totalsLine: `Total: ${snapshot.students.total} students enrolled · ${inr(snapshot.totalCollected)} collected`,
    batchesLine: batchLines.length ? `Batches:\n${batchLines.join("\n")}` : "Batches: none active",
  };
}

export function renderBriefing(b: Briefing): string {
  const lines = [`Here's where things stand (${b.atLabel} IST):`];
  if (b.attention.length) {
    lines.push("", "Needs attention:", ...b.attention.map(a => `• ${a}`));
  } else {
    lines.push("", "Nothing needs attention right now.");
  }
  lines.push("", b.todayLine, b.totalsLine, b.batchesLine);
  return lines.join("\n");
}

/* ── 2. Pending payments ────────────────────────────────────────── */

export interface PendingPaymentItem {
  id: string; status: string; student: string; roll: string | null;
  batch: string | null; amount: number; utr: string | null; age: string;
}

export async function listPendingPayments(db: SupabaseClient, limit = 15): Promise<{ count: number; items: PendingPaymentItem[] }> {
  const [payments, profiles, batches] = await Promise.all([fetchPayments(db), fetchProfiles(db), fetchBatches(db)]);
  const nameOf = new Map(profiles.map(p => [p.id, p]));
  const batchOf = new Map(batches.map(b => [b.id, b.name]));
  const rows = payments
    .filter(p => ["submitted", "reupload_requested"].includes(p.status))
    .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));
  const items = rows.slice(0, limit).map(p => {
    const s = p.student_id ? nameOf.get(p.student_id) : undefined;
    return {
      id: p.id,
      status: p.status,
      student: s?.full_name ?? "Unknown student",
      roll: s?.roll_number ?? null,
      batch: p.batch_id ? batchOf.get(p.batch_id) ?? null : null,
      amount: Number(p.amount ?? 0),
      utr: p.utr_number ?? null,
      age: ageLabel(p.created_at),
    };
  });
  return { count: rows.length, items };
}

export function renderPendingPayments(r: { count: number; items: PendingPaymentItem[] }): string {
  if (!r.count) return "No payments are waiting for review.";
  const lines = [`${r.count} payment${r.count === 1 ? "" : "s"} waiting for review (oldest first):`];
  for (const p of r.items) {
    lines.push(`• ${p.student}${p.roll ? ` (${p.roll})` : ""} — ${inr(p.amount)}${p.batch ? ` — ${p.batch}` : ""} — ${p.age}${p.utr ? ` — UTR ${p.utr}` : ""} — id ${p.id.slice(0, 8)}`);
  }
  if (r.count > r.items.length) lines.push(`…and ${r.count - r.items.length} more.`);
  lines.push("", `To act on one: "approve payment <id>" or "reject payment <id> because <reason>".`);
  return lines.join("\n");
}

/* ── 2b. Today's approved payments ─────────────────────────────────
 * Answers "did anyone pay today" with real names — NOT the pending queue.
 * Same "approved today" definition as the admin snapshot: status approved
 * and reviewed_at within the IST day. */

export interface TodayPaymentItem {
  student: string; roll: string | null; batch: string | null;
  amount: number; at: string;
}

export async function listTodayPayments(db: SupabaseClient, limit = 15) {
  const [payments, profiles, batches] = await Promise.all([fetchPayments(db), fetchProfiles(db), fetchBatches(db)]);
  const nameOf = new Map(profiles.map(p => [p.id, p]));
  const batchOf = new Map(batches.map(b => [b.id, b.name]));
  const start = istTodayStartIso();
  const rows = payments
    .filter(p => p.status === "approved" && p.reviewed_at && p.reviewed_at >= start)
    .sort((a, b) => Date.parse(b.reviewed_at ?? "") - Date.parse(a.reviewed_at ?? ""));
  const items: TodayPaymentItem[] = rows.slice(0, limit).map(p => {
    const s = p.student_id ? nameOf.get(p.student_id) : undefined;
    return {
      student: s?.full_name ?? "Unknown student",
      roll: s?.roll_number ?? null,
      batch: p.batch_id ? batchOf.get(p.batch_id) ?? null : null,
      amount: Number(p.amount ?? 0),
      at: p.reviewed_at
        ? new Date(p.reviewed_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })
        : "",
    };
  });
  return {
    count: rows.length,
    total: rows.reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
    items,
  };
}

export function renderTodayPayments(r: { count: number; total: number; items: TodayPaymentItem[] }): string {
  if (!r.count) return "No payments have been approved today yet.";
  const lines = [`Yes — ${r.count} payment${r.count === 1 ? "" : "s"} approved today (${inr(r.total)} total):`];
  for (const p of r.items) {
    lines.push(`• ${p.student}${p.roll ? ` (${p.roll})` : ""} — ${inr(p.amount)}${p.batch ? ` — ${p.batch}` : ""}${p.at ? ` — ${p.at}` : ""}`);
  }
  if (r.count > r.items.length) lines.push(`…and ${r.count - r.items.length} more.`);
  return lines.join("\n");
}

/* ── 3. Recent registrations ────────────────────────────────────── */

export async function listRecentRegistrations(db: SupabaseClient, days = 7, limit = 15) {
  const [profiles, batches] = await Promise.all([fetchProfiles(db), fetchBatches(db)]);
  const batchOf = new Map(batches.map(b => [b.id, b.name]));
  const cutoff = Date.now() - days * 86400000;
  const rows = profiles
    .filter(p => p.created_at && Date.parse(p.created_at) >= cutoff)
    .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""));
  return {
    days,
    count: rows.length,
    items: rows.slice(0, limit).map(p => ({
      name: p.full_name ?? "Unnamed",
      college: p.college,
      batch: p.batch_id ? batchOf.get(p.batch_id) ?? null : null,
      complete: !!p.is_profile_complete,
      when: ageLabel(p.created_at) === "today" ? "today" : ageLabel(p.created_at).replace(" old", ""),
    })),
  };
}

/* ── 4. Paid counts / collections ───────────────────────────────── */

export async function countPaid(db: SupabaseClient, batchRef?: string) {
  const [payments, profiles, batches] = await Promise.all([fetchPayments(db), fetchProfiles(db), fetchBatches(db)]);
  const scoped = matchBatches(batches, batchRef);
  const enrolledByBatch = new Map<string, number>();
  for (const p of profiles) {
    if (p.batch_id && p.is_profile_complete) enrolledByBatch.set(p.batch_id, (enrolledByBatch.get(p.batch_id) ?? 0) + 1);
  }
  return scoped.map(b => {
    const approved = payments.filter(pay => pay.batch_id === b.id && pay.status === "approved");
    return {
      batch: b.name,
      college: b.college,
      status: b.status,
      enrolled: enrolledByBatch.get(b.id) ?? 0,
      paid: new Set(approved.map(a => a.student_id)).size,
      collected: approved.reduce((sum, a) => sum + Number(a.amount ?? 0), 0),
      fee: b.fee_amount == null ? null : Number(b.fee_amount),
    };
  });
}

/* ── 5. Unpaid students ─────────────────────────────────────────── */

export async function listUnpaidStudents(db: SupabaseClient, batchRef: string | undefined, limit = 25) {
  const [payments, profiles, batches] = await Promise.all([fetchPayments(db), fetchProfiles(db), fetchBatches(db)]);
  const scoped = matchBatches(batches, batchRef).filter(b => b.status !== "archived");
  const batchIds = new Set(scoped.map(b => b.id));
  const batchOf = new Map(scoped.map(b => [b.id, b.name]));
  const paidPairs = new Set(payments.filter(p => p.status === "approved" && p.batch_id && batchIds.has(p.batch_id)).map(p => `${p.student_id}:${p.batch_id}`));
  const unpaid = profiles.filter(p => p.is_profile_complete && p.batch_id && batchIds.has(p.batch_id) && !paidPairs.has(`${p.id}:${p.batch_id}`));
  return {
    batches: scoped.map(b => b.name),
    count: unpaid.length,
    items: unpaid.slice(0, limit).map(p => ({
      name: p.full_name ?? "Unnamed",
      roll: p.roll_number,
      phone: p.phone,
      batch: p.batch_id ? batchOf.get(p.batch_id) ?? null : null,
    })),
  };
}

/* ── 6. Find one student ────────────────────────────────────────── */

export async function findStudent(db: SupabaseClient, query: string) {
  const [profiles, payments, batches] = await Promise.all([fetchProfiles(db), fetchPayments(db), fetchBatches(db)]);
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\D/g, "");
  const phoneTail = digits.length >= 10 ? digits.slice(-10) : null;
  const batchOf = new Map(batches.map(b => [b.id, b.name]));
  const matches = profiles.filter(p => {
    if (phoneTail && (p.phone ?? "").replace(/\D/g, "").slice(-10) === phoneTail) return true;
    if (p.roll_number && p.roll_number.toLowerCase() === q) return true;
    if (q.length >= 3 && (p.full_name ?? "").toLowerCase().includes(q)) return true;
    return false;
  }).slice(0, 5);
  return matches.map(p => {
    const mine = payments
      .filter(pay => pay.student_id === p.id)
      .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""));
    const latest = mine[0] ?? null;
    return {
      id: p.id,
      name: p.full_name ?? "Unnamed",
      phone: p.phone,
      roll: p.roll_number,
      college: p.college,
      branch: p.branch,
      year: p.year,
      batch: p.batch_id ? batchOf.get(p.batch_id) ?? null : null,
      complete: !!p.is_profile_complete,
      joined: p.created_at,
      latest_payment: latest ? { id: latest.id, status: latest.status, amount: Number(latest.amount ?? 0), when: ageLabel(latest.created_at), utr: latest.utr_number } : null,
    };
  });
}

/* ── 7. Open questions ──────────────────────────────────────────── */

interface UnknownQuestionRow { id: string; short_id: number | null; question: string; created_at: string | null; status: string; student_phone: string | null }

/**
 * Recent conversation behind a pending question, so the admin sees context
 * instead of an isolated sentence. Best-effort and read-only — never throws.
 * Sources: the rolling WhatsApp transcript (whatsapp_moderation.recent_turns,
 * keyed by 10-digit phone) and the student's latest in-app thread
 * (student_queries → student_query_messages).
 */
async function getQuestionConversation(db: SupabaseClient, phone: string | null): Promise<string[]> {
  if (!phone) return [];
  const lines: string[] = [];
  try {
    // 1. WhatsApp turns (rolling last-10 store, keyed by 10-digit phone).
    // Fetch-then-first keeps the module's chainable-fake test pattern working.
    const p = normalizePhone(phone);
    const { data: mods } = await db.from("whatsapp_moderation").select("recent_turns").eq("phone", p);
    const turns: any[] = Array.isArray((mods as any[])?.[0]?.recent_turns) ? (mods as any[])[0].recent_turns : [];
    for (const t of turns.slice(-4)) {
      const body = String(t?.t ?? "").slice(0, 160).trim();
      if (body) lines.push(`${t?.r === "u" ? "Student" : "Bot"}: ${body}`);
    }
    // 2. In-app thread: latest student_queries row for this phone, then its turns.
    const { data: profs } = await db.from("profiles").select("id").eq("phone", phone);
    const pid: string | undefined = ((profs as any[]) ?? [])[0]?.id;
    if (pid) {
      const { data: threads } = await db.from("student_queries").select("id").eq("student_id", pid).order("created_at", { ascending: false }).limit(1);
      const qid: string | undefined = ((threads as any[]) ?? [])[0]?.id;
      if (qid) {
        const { data: msgs } = await db.from("student_query_messages").select("sender, body").eq("query_id", qid).order("created_at", { ascending: false }).limit(4);
        for (const m of (((msgs as any[]) ?? []).reverse())) {
          const body = String((m as any)?.body ?? "").slice(0, 160).trim();
          if (body) lines.push(`${(m as any)?.sender === "admin" ? "Admin" : "Student"}: ${body}`);
        }
      }
    }
  } catch { /* conversation context is optional */ }
  return lines;
}

export async function listOpenQuestions(db: SupabaseClient, limit = 10) {
  const { data, error } = await db.from("unknown_questions").select("id, short_id, question, created_at, status, student_phone").eq("status", "pending");
  if (error) throw new Error("Could not read unknown_questions; live data is unavailable.");
  const rows = ((data ?? []) as UnknownQuestionRow[]).sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));
  const items = rows.slice(0, limit);
  const conversations = await Promise.all(items.map(r => getQuestionConversation(db, r.student_phone)));
  return {
    count: rows.length,
    items: items.map((r, i) => ({
      display_id: r.short_id != null ? `UQ-${String(r.short_id).padStart(3, "0")}` : r.id.slice(0, 8),
      question: r.question,
      age: ageLabel(r.created_at),
      conversation: conversations[i],
    })),
  };
}

export function renderOpenQuestions(r: { count: number; items: { display_id: string; question: string; age: string; conversation: string[] }[] }): string {
  if (!r.count) return "No student questions are waiting for an answer.";
  const lines = [`${r.count} open question${r.count === 1 ? "" : "s"} (oldest first):`];
  for (const q of r.items) {
    lines.push(`• ${q.display_id} — "${q.question}" — ${q.age}`);
    for (const turn of q.conversation) lines.push(`    ${turn}`);
  }
  if (r.count > r.items.length) lines.push(`…and ${r.count - r.items.length} more.`);
  return lines.join("\n");
}

/* ── 8. Batch status ────────────────────────────────────────────── */

export async function getBatchStatus(db: SupabaseClient) {
  const [profiles, batches] = await Promise.all([fetchProfiles(db), fetchBatches(db)]);
  const enrolledByBatch = new Map<string, number>();
  for (const p of profiles) {
    if (p.batch_id && p.is_profile_complete) enrolledByBatch.set(p.batch_id, (enrolledByBatch.get(p.batch_id) ?? 0) + 1);
  }
  return batches.map(b => ({
    name: b.name,
    college: b.college,
    status: b.status,
    enrolled: enrolledByBatch.get(b.id) ?? 0,
    limit: b.batch_limit,
    fee: b.fee_amount == null ? null : Number(b.fee_amount),
    upi_set: !!b.upi_id,
    group_link_set: !!b.whatsapp_group_link,
  }));
}

/* ── 9. Waitlist ────────────────────────────────────────────────── */

export async function getWaitlist(db: SupabaseClient) {
  const { data, error } = await db.from("batch_waiting_queue").select("college, phone, created_at, processed_at").is("processed_at", null);
  if (error) throw new Error("Could not read batch_waiting_queue; live data is unavailable.");
  const rows = (data ?? []) as Array<{ college: string; phone: string | null; created_at: string | null }>;
  const byCollege = new Map<string, number>();
  for (const r of rows) byCollege.set(r.college, (byCollege.get(r.college) ?? 0) + 1);
  return {
    total: rows.length,
    by_college: Array.from(byCollege.entries()).map(([college, waiting]) => ({ college, waiting })),
  };

}

/** Detailed waitlist rows for follow-up questions such as "details of their". */
export async function getWaitlistDetails(db: SupabaseClient) {
  const { data: queue } = await db
    .from("batch_waiting_queue")
    .select("college, phone, created_at")
    .is("processed_at", null)
    .order("created_at", { ascending: true });
  const rows = (queue ?? []) as Array<{ college: string; phone: string | null; created_at: string | null }>;
  if (!rows.length) return "The waitlist is empty.";

  const phones = rows.map(r => r.phone).filter((p): p is string => !!p);
  const { data: profiles } = phones.length
    ? await db.from("profiles").select("full_name, phone, roll_number, branch, year, college").in("phone", phones)
    : { data: [] as any[] };

  const byPhone = new Map(
    (profiles ?? []).map((p: any) => [String(p.phone ?? "").replace(/\D/g, "").slice(-10), p]),
  );

  const lines = rows.map((r, i) => {
    const key = String(r.phone ?? "").replace(/\D/g, "").slice(-10);
    const p = byPhone.get(key);
    const details = [
      p?.full_name ? "Name: " + p.full_name : null,
      p?.roll_number ? "Roll: " + p.roll_number : null,
      p?.branch ? "Branch: " + p.branch : null,
      p?.year ? "Year: " + p.year : null,
      "College: " + r.college,
      r.phone ? "Phone: +" + r.phone : null,
    ].filter(Boolean).join(" | ");
    return (i + 1) + ". " + details;
  });

  return "Wait-list details (" + rows.length + " student" + (rows.length === 1 ? "" : "s") + "):\n\n" + lines.join("\n");
}

/* ── 10. Missing signatures ─────────────────────────────────────── */

export async function listMissingSignatures(db: SupabaseClient, batchRef?: string, limit = 25) {
  const [profiles, batches] = await Promise.all([fetchProfiles(db), fetchBatches(db)]);
  const scoped = matchBatches(batches, batchRef);
  const batchIds = batchRef ? new Set(scoped.map(b => b.id)) : null;
  const batchOf = new Map(batches.map(b => [b.id, b.name]));
  const rows = profiles.filter(p =>
    p.college_id_path && p.college_id_ai_flag?.hasSignature === false && (!batchIds || (p.batch_id && batchIds.has(p.batch_id))),
  );
  return {
    count: rows.length,
    items: rows.slice(0, limit).map(p => ({
      name: p.full_name ?? "Unnamed",
      roll: p.roll_number,
      batch: p.batch_id ? batchOf.get(p.batch_id) ?? null : null,
    })),
  };
}

/** Document and petition metadata only. Never expose file paths or signed URLs. */
export async function getStudentDocuments(db: SupabaseClient, query: string) {
  const students = await findStudent(db, query);
  const profiles = await fetchProfiles(db);
  return Promise.all(students.map(async student => {
    const profile = profiles.find(p => p.id === student.id);
    const { data, error } = await db.from("petitions")
      .select("status, created_at, reviewed_at").eq("student_id", student.id)
      .order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error("Could not read petition status; live data is unavailable.");
    return {
      student: student.name, roll: student.roll, batch: student.batch,
      college_id_uploaded: !!profile?.college_id_path,
      signature_check: profile?.college_id_ai_flag?.hasSignature ?? null,
      petition: data?.[0] ?? null,
      note: "College ID/signature checks and recorded petition status only. Certificate delivery and legal outcomes are not inferred.",
    };
  }));
}

/* ── deterministic fast path ────────────────────────────────────── */

export type FastRead = "briefing" | "pending_payments" | "today_payments" | "open_questions" | "batch_status" | "waitlist";

/**
 * Catches unambiguous read-only phrases so they get instant, LLM-free,
 * always-correct answers. Deliberately tight: anything looser goes to the
 * agent loop, which can reason over the same tools.
 */
export function matchFastRead(question: string): FastRead | null {
  const q = question.trim();
  // Never swallow actions or scoped/multi-part requests as a generic summary.
  if (/\b(?:approve|reject|delete|send|remind|edit|update|change|set|archive|create|verify)\b/i.test(q)) return null;
  if (/\b(?:GNITC?|BIET|batch\s*\d+|compare)\b/i.test(q)) return null;
  if (/^(?:pending payments? (?:enni|enti|chupinchu)|payments? pending (?:enni|enti)|పెండింగ్ పేమెంట్స్)(?:[?!. ]*)$/i.test(q)) return "pending_payments";
  if (/^(?:batches? (?:status|chupinchu)|బ్యాచ్ స్టేటస్)(?:[?!. ]*)$/i.test(q)) return "batch_status";
  if (!q) return null;
  if (/^(brief me|briefing|daily (briefing|brief|report|summary)|morning (report|briefing)|platform (status|overview)|project status|student platform status|status|overview|summary|what needs (my )?attention\??|anything needs (my )?attention\??)[.! ]*$/i.test(q)) return "briefing";
  if (/what needs (my )?attention/i.test(q)) return "briefing";
  if (/^(summarise|summarize)( today'?s? (activity|day))?[.! ]*$/i.test(q)) return "briefing";
  if (/\bpending payments?\b/i.test(q) || /\bpayments? (awaiting|waiting|pending|to) (review|approval)\b/i.test(q) || /^show( me)? (the )?pending\b/i.test(q)) return "pending_payments";
  // "Paid today" is about money received, never the review queue. Checked
  // after the pending patterns so "today's pending payments" still wins as pending.
  if (/\b(?:did\s+any(?:one|body)\s+(?:pay|paid)|who\s+(?:paid|has\s+paid)|payments?\s+(?:made\s+|received\s+|collected\s+)?today|today'?s?\s+payments?|paid\s+today)\b/i.test(q)) return "today_payments";
  if (/\b(open|unanswered|pending|unknown) questions?\b/i.test(q) || /\bquestions? (queue|waiting)\b/i.test(q)) return "open_questions";
  if (/\bactive batches\b/i.test(q) || /\bbatches? (are )?(active|open)\b/i.test(q) || /\bbatch (status|overview)\b/i.test(q)) return "batch_status";
  if (/\b(wait ?list|waiting (list|queue))\b/i.test(q)) return "waitlist";
  return null;
}

export async function runFastRead(db: SupabaseClient, kind: FastRead): Promise<string> {
  switch (kind) {
    case "briefing": return renderBriefing(await getBriefing(db));
    case "pending_payments": return renderPendingPayments(await listPendingPayments(db));
    case "today_payments": return renderTodayPayments(await listTodayPayments(db));
    case "open_questions": return renderOpenQuestions(await listOpenQuestions(db));
    case "batch_status": {
      const rows = await getBatchStatus(db);
      if (!rows.length) return "There are no active batches right now.";
      return rows.map(b => {
        const seats = b.limit ? `${b.enrolled}/${b.limit}` : `${b.enrolled} enrolled`;
        const fee = b.fee && b.fee > 0 ? `fee ${inr(b.fee)}` : "no fee set";
        return `• ${b.name} (${b.status}) — ${seats} — ${fee}${b.upi_set ? "" : " — no UPI set"}`;
      }).join("\n");
    }
    case "waitlist": {
      const w = await getWaitlist(db);
      if (!w.total) return "The waitlist is empty.";
      return `${w.total} student${w.total === 1 ? "" : "s"} waiting:\n` + w.by_college.map(c => `• ${c.college}: ${c.waiting}`).join("\n");
    }
  }
}
