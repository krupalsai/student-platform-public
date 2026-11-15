import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyStudent } from "@/lib/services/student-notifications";

/**
 * In-app support cases: the human side of the Student App assistant.
 *
 * A thread becomes a case (status `pending_admin`) when the assistant
 * escalates. A team reply is written INTO that same thread as a
 * `sender: "admin"` message, so the student reads it where they asked —
 * WhatsApp/push only notify that it's there.
 *
 * Three ways an answer can arrive, all funnelled through postTeamReply:
 *   - /admin/support (reply directly in the thread)
 *   - WhatsApp `ANSWER <id> <answer>` (admin.ts)
 *   - /admin/questions answer-cluster (question-queue.ts)
 */

export async function postTeamReply(
  db: SupabaseClient,
  queryId: string,
  body: string,
  adminProfileId: string | null,
  opts: { resolve?: boolean } = {},
): Promise<{ ok: boolean; studentId: string | null }> {
  const text = body.trim();
  if (!text) return { ok: false, studentId: null };

  const { data: thread } = await db
    .from("student_queries").select("id, student_id, unknown_question_id, created_at").eq("id", queryId).maybeSingle();
  if (!thread) return { ok: false, studentId: null };

  const { error } = await db.from("student_query_messages").insert({
    query_id: queryId,
    sender: "admin",
    author_id: adminProfileId,
    body: text,
  });
  if (error) {
    console.error("[support-cases] team reply insert failed:", error.message);
    return { ok: false, studentId: thread.student_id };
  }

  const nowIso = new Date().toISOString();
  await db.from("student_queries").update({
    status: opts.resolve ? "resolved" : "answered",
    last_message_at: nowIso,
    last_sender: "admin",
    admin_responded_at: nowIso,
    answered_at: nowIso,
    answered_by: adminProfileId,
    ...(opts.resolve ? { resolved_at: nowIso } : {}),
  }).eq("id", queryId);

  await closeLinkedQuestions(db, thread);

  if (thread.student_id) {
    await notifyStudent(
      db, thread.student_id, "support_reply",
      "The support team replied to your question. Open Support in the Student App to read it.",
      queryId, { url: "/support" },
    ).catch((e) => console.error("[support-cases] notify failed:", (e as Error).message));
  }
  return { ok: true, studentId: thread.student_id };
}

/**
 * An unknown question answered from WhatsApp or /admin/questions: deliver
 * the answer into every in-app thread still waiting on it. Best-effort —
 * never throws, since the answer itself is already saved as an FAQ.
 */
export async function deliverAnswerToAppThreads(
  db: SupabaseClient,
  unknownQuestionIds: string[],
  answer: string,
  adminProfileId: string | null = null,
): Promise<number> {
  if (!unknownQuestionIds.length || !answer.trim()) return 0;
  try {
    const { data: threads } = await db
      .from("student_queries")
      .select("id")
      .in("unknown_question_id", unknownQuestionIds)
      .eq("status", "pending_admin");
    let delivered = 0;
    for (const t of threads ?? []) {
      const r = await postTeamReply(db, t.id, answer, adminProfileId);
      if (r.ok) delivered++;
    }
    return delivered;
  } catch (e) {
    console.error("[support-cases] deliverAnswerToAppThreads failed:", (e as Error).message);
    return 0;
  }
}

/**
 * A team reply answers the student's open question(s). Mark them answered so
 * self-watch's 24h "still unanswered" re-alert (proactive-nudges.ts) does not
 * nag the admins about something already handled in the Support Inbox (item
 * #241). Covers the thread's linked question plus any other still-pending
 * question this student's phone raised since the thread began (an older bug
 * created one per repeat). Best-effort — never throws.
 */
async function closeLinkedQuestions(
  db: SupabaseClient,
  thread: { student_id: string | null; unknown_question_id: string | null; created_at: string | null },
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const mark = { status: "answered", answered_by: "support-inbox", answered_at: nowIso };
    if (thread.unknown_question_id) {
      await db.from("unknown_questions").update(mark).eq("id", thread.unknown_question_id).eq("status", "pending");
    }
    if (thread.student_id && thread.created_at) {
      const { data: p } = await db.from("profiles").select("phone").eq("id", thread.student_id).maybeSingle();
      const ten = String((p as { phone?: string | null } | null)?.phone ?? "").replace(/\D/g, "").slice(-10);
      if (ten.length === 10) {
        await db.from("unknown_questions").update(mark)
          .in("student_phone", [ten, `91${ten}`, `+91${ten}`])
          .eq("status", "pending").gte("first_seen_at", thread.created_at);
      }
    }
  } catch (e) {
    console.error("[support-cases] closeLinkedQuestions failed:", (e as Error).message);
  }
}
