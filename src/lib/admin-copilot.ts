import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Admin Copilot — the READ-ONLY, snapshot-grounded Q&A fallback.
 *
 * `/api/admin/copilot` tries a deterministic command parser
 * (`admin-copilot-intent.ts`) and an AI action planner (`admin-copilot-agent.ts`)
 * FIRST — those genuinely mutate data (batch fee/settings, batch messages,
 * payment approve/reject, student edit/delete, ID verification), all behind an
 * explicit confirmation step. This module is only reached when NEITHER of
 * those recognised the request as an action, so its system prompt below must
 * not claim it can never take action (it can, just not via this path) and
 * must not invent nonexistent UI when declining — see buildSystemPrompt.
 * getAdminSnapshot() itself still runs SELECT queries only.
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";

export interface AdminSnapshot {
  generatedAtIso: string;
  students: { total: number; complete: number; incomplete: number };
  today: { registrations: number; approvedPayments: number; collected: number };
  payments: Record<string, number>;
  totalCollected: number;
  batches: Array<{ name: string; college: string; status: string; fee: number | null; enrolled: number }>;
  byCollege: Array<{ college: string; students: number; activeBatch: string | null; activeBatchFee: number | null }>;
  waitlistByCollege: Array<{ college: string; waiting: number }>;
  pendingUnknownQuestions: number;
}

/** IST (UTC+5:30) midnight as a UTC instant, for "today" filters. */
function istTodayStartIso(): string {
  const offset = 5.5 * 3600 * 1000;
  const istNow = new Date(Date.now() + offset);
  const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
  return new Date(istMidnight - offset).toISOString();
}

/**
 * Gathers a compact, read-only snapshot of the platform for the Copilot to
 * reason over. Small data set (a few hundred rows at most), aggregated in JS.
 */
export async function getAdminSnapshot(db: SupabaseClient): Promise<AdminSnapshot> {
  const todayStart = istTodayStartIso();

  const [profilesRes, paymentsRes, batchesRes, waitlistRes, uqRes] = await Promise.all([
    // No role filter: the student counts below use the platform's ONE
    // enrolment definition (batch_id + is_profile_complete, any role —
    // see lib/admin-stats.ts). Filtering role='student' here is what made
    // this snapshot disagree with the WhatsApp bot's STATUS totals.
    db.from("profiles").select("college, batch_id, is_profile_complete, created_at"),
    db.from("payments").select("status, amount, created_at, reviewed_at, batch_id"),
    db.from("batches").select("id, name, college, fee_amount, status").neq("status", "archived"),
    db.from("batch_waiting_queue").select("college").is("processed_at", null),
    db.from("unknown_questions").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  if ([profilesRes, paymentsRes, batchesRes, waitlistRes, uqRes].some(r => r.error)) {
    throw new Error("Could not read the complete live snapshot. No totals can be verified.");
  }

  const profiles = profilesRes.data ?? [];
  const payments = paymentsRes.data ?? [];
  const batches = batchesRes.data ?? [];
  const waitlist = (waitlistRes.data ?? []) as Array<{ college: string }>;

  // Students — enrolled only (complete profile AND in a batch), the same
  // definition the WhatsApp STATUS command and lib/admin-stats use. Raw
  // account rows (213 on 2026-10-22, most of them incomplete signups)
  // are not "students" on any other surface.
  const total = profiles.filter((p: any) => p.batch_id && p.is_profile_complete).length;
  const complete = total;
  const incomplete = profiles.length - total;

  // Enrolled per batch id
  const enrolledByBatch = new Map<string, number>();
  for (const p of profiles as any[]) {
    if (p.batch_id && p.is_profile_complete) enrolledByBatch.set(p.batch_id, (enrolledByBatch.get(p.batch_id) ?? 0) + 1);
  }

  // Payments by status + collected + today
  const paymentCounts: Record<string, number> = {};
  let totalCollected = 0;
  let todayApproved = 0;
  let todayCollected = 0;
  for (const pay of payments as any[]) {
    paymentCounts[pay.status] = (paymentCounts[pay.status] ?? 0) + 1;
    if (pay.status === "approved") {
      totalCollected += Number(pay.amount ?? 0);
      if (pay.reviewed_at && pay.reviewed_at >= todayStart) {
        todayApproved += 1;
        todayCollected += Number(pay.amount ?? 0);
      }
    }
  }

  const todayRegistrations = (profiles as any[]).filter(
    p => p.batch_id && p.is_profile_complete && p.created_at && p.created_at >= todayStart
  ).length;

  // Batches with enrollment
  const batchList = (batches as any[]).map(b => ({
    name: b.name, college: b.college, status: b.status,
    fee: b.fee_amount == null ? null : Number(b.fee_amount),
    enrolled: enrolledByBatch.get(b.id) ?? 0,
  }));

  // Per-college rollup
  const collegeSet = Array.from(new Set([
    ...(profiles as any[]).map(p => p.college).filter(Boolean),
    ...batchList.map(b => b.college),
  ]));
  const byCollege = collegeSet.map(college => {
    const activeBatch = batchList.find(b => b.college === college && b.status === "active") ?? null;
    return {
      college,
      students: (profiles as any[]).filter(p => p.batch_id && p.is_profile_complete && p.college === college).length,
      activeBatch: activeBatch?.name ?? null,
      activeBatchFee: activeBatch?.fee ?? null,
    };
  });

  const waitlistByCollege = Object.entries(
    waitlist.reduce((acc, w) => { acc[w.college] = (acc[w.college] ?? 0) + 1; return acc; }, {} as Record<string, number>)
  ).map(([college, waiting]) => ({ college, waiting }));

  return {
    generatedAtIso: new Date().toISOString(),
    students: { total, complete, incomplete },
    today: { registrations: todayRegistrations, approvedPayments: todayApproved, collected: todayCollected },
    payments: paymentCounts,
    totalCollected,
    batches: batchList,
    byCollege,
    waitlistByCollege,
    pendingUnknownQuestions: uqRes.count ?? 0,
  };
}

function buildSystemPrompt(snapshot: AdminSnapshot, voiceMode = false): string {
  const istTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  return (
    `You are the Admin Copilot for the Student Platform (a Telegram/WhatsApp fee-collection app for GNIT & GNITC colleges in India). ` +
    `You help administrators by ANSWERING questions, SUMMARISING data, and SUGGESTING next steps.\n\n` +
    `CURRENT TIME: ${istTime} IST\n\n` +
    `STRICT RULES:\n` +
    `- You are answering because an earlier step already checked whether this request was a recognised action (batch fee/settings changes, batch WhatsApp messages, signature checks, payment approve/reject, student edit/delete) and it wasn't — so you are READ-ONLY for THIS specific reply. You cannot approve/reject payments, create/end batches, edit/delete, or message students yourself right now.\n` +
    `- If the request looks like it WAS trying to do one of those things (e.g. asking to message a batch with no message text given), say plainly what's missing and how to phrase it — do NOT invent a screen, menu, or page name that may not exist. Never claim there is a dedicated page for something unless it appears in the DATA SNAPSHOT or you are certain of the real navigation.\n` +
    `- Answer ONLY from the DATA SNAPSHOT below. If the snapshot doesn't contain the answer, say so plainly. Never invent numbers.\n` +
    `- Amounts are in Indian Rupees (₹). Be concise and specific; use short bullet lists for multi-part answers.\n` +
    `- ANSWER STYLE — plain words, like explaining to a friend: short plain lines, one fact per line, numbers first. Example: "Today (26 Oct): 0 new registrations. Payments today: 0. Approved: 0 (₹0). Total students enrolled: 102." For a list, use numbered plain lines: "Last 7 days: 2 new registrations. 1. Sample Student — GNITC Batch 2, profile complete, 3 days ago. 2. Unnamed — profile incomplete, 3 days ago." NEVER use a markdown table (| pipes or --- separators). No jargon, no long paragraphs, no hedging. Direct answer first, then at most one short follow-up question.\n` +
    (voiceMode
      ? `- VOICE CONVERSATION STYLE: sound like a natural, attentive ChatGPT-style voice assistant, not a scripted IVR. Answer the question directly, use the recent context for follow-ups, avoid repeated greetings and capability menus, and ask at most one short clarifying question when needed.\n` +
        `- For speech, prefer plain conversational sentences and brief answers. Do not read headings, markdown, or long lists aloud. Never claim an action happened unless a verified tool result confirms it.\n`
      : ``) +
    `\nDATA SNAPSHOT (JSON):\n${JSON.stringify(snapshot, null, 2)}`
  );
}

export interface CopilotTurn { role: "user" | "assistant"; content: string }

/**
 * Answers an admin question grounded in the snapshot, via Groq. Returns null
 * if the model is unconfigured/unavailable/times out (caller shows a fallback).
 * Never throws.
 */
export async function answerAdminQuestion(
  question: string,
  snapshot: AdminSnapshot,
  history: CopilotTurn[] = [],
  voiceMode = false,
): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL ?? DEFAULT_MODEL,
        messages: [
          { role: "system", content: buildSystemPrompt(snapshot, voiceMode) },
          ...history.slice(-6).map(t => ({ role: t.role, content: t.content })),
          { role: "user", content: question },
        ],
        temperature: 0.2,
        max_tokens: 500,
      }),
      signal: controller.signal,
    });
    if (!res.ok) { console.error("[admin-copilot] groq http", res.status); return null; }
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch (e) {
    console.error("[admin-copilot] groq failed:", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

