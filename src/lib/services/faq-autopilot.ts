/**
 * FAQ autopilot (item #222) — the bot improves itself, no human approval.
 *
 * When the assistant answers a genuine question that no FAQ covered, the
 * answer is saved as a disabled draft (`saveDraftFaq`, source='ai_draft').
 * Before this, a draft only went live when an admin typed APPROVE on
 * WhatsApp. Now self-watch reviews drafts on a schedule:
 *
 *   1. Hard filters, no model call: fragments, cut-off answers, personal
 *      replies, amounts, dates, legal/court timelines, payment verdicts.
 *      These are deleted.
 *   2. A model judges what is left against PLATFORM_REFERENCE (the same
 *      grounding the bot answers from): generic, correct, useful to the next
 *      student → PUBLISH; anything else → REJECT.
 *   3. PUBLISH → enabled=true (now used by every FAQ search). REJECT → deleted.
 *
 * Fails CLOSED: if no model answers, nothing is published; the draft waits
 * for the next run. Only rows with source='ai_draft' are touched, so a FAQ an
 * admin disabled on purpose is never re-enabled. An admin can still APPROVE
 * or REJECT a draft early on WhatsApp.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PLATFORM_REFERENCE } from "@/lib/intent-engine/platform-knowledge";
import { embedText } from "@/lib/embeddings";

export type DraftVerdict = { verdict: "publish" | "reject" | "skip"; reason: string };

/** Deterministic pre-checks. Returns a reason to reject, or null to go on to the judge. Pure. */
export function hardRejectReason(question: string, answer: string): string | null {
  const q = question.trim();
  const a = answer.trim();
  if (q.split(/\s+/).length < 3 || q.length < 12) return "question too short to be reusable";
  if (!/\?\s*$/.test(q) && !/^(how|what|when|where|why|who|which|can|is|are|do|does|did|will|should|could|may|i want|i need|tell me|explain)\b/i.test(q)) return "not a clear question";
  if (q.split(/\s+/).length < 6 && /\b(that|this|it|them|those)\??\s*$/i.test(q)) return "question depends on earlier chat";
  if (a.length < 40) return "answer too short";
  if (/\?\s*(😊|🙂|👍)?\s*$/.test(a)) return "answer is a clarifying question";
  if (/\b(since you('| a)re already|your (payment|registration|id|profile) (is|was|has)|you('| ha)ve (already )?(paid|registered|uploaded))\b/i.test(a)) return "answer assumes one student's situation";
  if (!/[.!?)"'”]$/.test(a)) return "answer looks cut off";
  if (/(?:₹|\brs\.?|\binr)\s*\d|\b\d{3,}\b/i.test(a)) return "answer contains an amount or number";
  if (/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i.test(a)) return "answer contains a date";
  if (/^\s*(hi|hey|hello|dear)\s+[a-z]+/i.test(a)) return "personal reply";
  if (/\byour (payment|registration|profile|college id|batch|account)\b.{0,40}\b(is|was|has been|shows|approved|pending|rejected)\b/i.test(a)) return "answer is about one student's own record";
  if (/\b(court|hearing|judg(e)?ment|petition (status|date)|lawyer|advocate|verdict)\b/i.test(q + " " + a)) return "legal/court topic — only a human answers these";
  if (/\b(when will|how long|by when|which date|what date)\b/i.test(q)) return "timeline question";
  return null;
}

const JUDGE_PROMPT = `You review answers a student-support bot gave, deciding whether each may be reused as a public FAQ for ALL students.

PUBLISH only if every one is true:
- The question is a real, general question other students will ask (not a fragment, not chit-chat).
- The answer is fully consistent with the PLATFORM FACTS below and invents nothing (no new policy, deadlines, amounts, phone numbers, promises).
- The answer contains nothing about one specific student (no names, no "your payment is…").
- It never states a fee amount, a court/hearing date, or a legal outcome.
- It is complete, clear and actually answers the question.

Otherwise REJECT. When unsure, REJECT.

Reply with JSON only: {"verdict":"PUBLISH"|"REJECT","reason":"<one short sentence>"}

PLATFORM FACTS:
`;

function parseVerdict(text: string): DraftVerdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { verdict?: string; reason?: string };
    const v = String(j.verdict ?? "").toUpperCase();
    if (v !== "PUBLISH" && v !== "REJECT") return null;
    return { verdict: v === "PUBLISH" ? "publish" : "reject", reason: String(j.reason ?? "").slice(0, 300) };
  } catch {
    return null;
  }
}

async function judgeWithGroq(user: string): Promise<DraftVerdict | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
        temperature: 0,
        max_tokens: 1024,
        messages: [
          { role: "system", content: JUDGE_PROMPT + PLATFORM_REFERENCE },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return parseVerdict(String(j?.choices?.[0]?.message?.content ?? ""));
  } catch {
    return null;
  }
}

async function judgeWithGemini(user: string): Promise<DraftVerdict | null> {
  const key = process.env.EMBEDDINGS_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_CHAT_MODEL ?? "gemini-3.6-flash";
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: JUDGE_PROMPT + PLATFORM_REFERENCE }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
    return parseVerdict(text);
  } catch {
    return null;
  }
}

export async function judgeDraft(question: string, answer: string): Promise<DraftVerdict> {
  const hard = hardRejectReason(question, answer);
  if (hard) return { verdict: "reject", reason: hard };
  const user = `QUESTION:\n${question}\n\nANSWER:\n${answer}`;
  const v = (await judgeWithGroq(user)) ?? (await judgeWithGemini(user));
  return v ?? { verdict: "skip", reason: "no reviewer model available — retry next run" };
}

/**
 * Reviews up to `limit` AI drafts that are at least `minAgeHours` old (so an
 * admin who wants to can still REJECT one first). Publishes or deletes each.
 */
export async function reviewDraftFaqs(
  db: SupabaseClient,
  opts: { limit?: number; minAgeHours?: number } = {},
): Promise<{ reviewed: number; published: number; rejected: number; skipped: number; log: Array<{ question: string; verdict: string; reason: string }> }> {
  const limit = opts.limit ?? 5;
  const minAgeHours = opts.minAgeHours ?? Number(process.env.FAQ_AUTOPILOT_MIN_AGE_HOURS ?? 24);
  const cutoff = new Date(Date.now() - minAgeHours * 3600_000).toISOString();
  const out = { reviewed: 0, published: 0, rejected: 0, skipped: 0, log: [] as Array<{ question: string; verdict: string; reason: string }> };

  const { data, error } = await db
    .from("faqs")
    .select("id, question, answer, embedding")
    .eq("enabled", false)
    .eq("source", "ai_draft")
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[faq-autopilot] load failed:", error.message);
    return out;
  }

  for (const row of (data ?? []) as Array<{ id: string; question: string; answer: string; embedding: unknown }>) {
    out.reviewed++;
    const v = await judgeDraft(row.question, row.answer);
    out.log.push({ question: row.question.slice(0, 80), verdict: v.verdict, reason: v.reason });
    if (v.verdict === "skip") {
      out.skipped++;
      continue;
    }
    if (v.verdict === "reject") {
      const { error: delErr } = await db.from("faqs").delete().eq("id", row.id).eq("enabled", false).eq("source", "ai_draft");
      if (!delErr) out.rejected++;
      continue;
    }
    const embedding = row.embedding ? null : await embedText(row.question).catch(() => null);
    const { error: upErr } = await db
      .from("faqs")
      .update({
        enabled: true,
        source: "ai_published",
        reviewed_at: new Date().toISOString(),
        review_note: `auto: ${v.reason}`.slice(0, 500),
        ...(embedding ? { embedding } : {}),
      })
      .eq("id", row.id)
      .eq("enabled", false)
      .eq("source", "ai_draft");
    if (!upErr) out.published++;
  }
  return out;
}
