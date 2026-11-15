import { SupabaseClient } from "@supabase/supabase-js";
import { notifyStudent } from "@/lib/services/student-notifications";

/**
 * Posting an announcement — shared by the website route
 * (POST /api/admin/announcements) and the WhatsApp ANNOUNCE command.
 *
 * Shared deliberately: an announcement that reaches students from the website
 * but not from WhatsApp (or vice versa) is the kind of split that item #113
 * had to go back and clean up once three copies of a send loop had already
 * drifted apart.
 */

export interface AnnouncementInput {
  title: string;
  body: string;
  college: string;
  batch_id: string | null;
  priority: "normal" | "urgent";
  expires_at?: string | null;
  attachment_url?: string | null;
  attachment_name?: string | null;
}

export interface AnnouncementResult {
  announcement: { id: string; [k: string]: unknown };
  /** Push actually delivered to at least one of the student's devices. */
  pushSent: number;
  /** Push attempted (student had a subscription) but every attempt failed. */
  pushFailed: number;
  /** Recipients with no push subscription at all — inbox only. */
  pushNoSubscription: number;
  /** Recipients who got the in-app inbox row (the reliable fallback). */
  inboxSaved: number;
  recipients: number;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Who should receive this.
 *
 * A BATCH announcement uses the item #103 enrolment rule — batch_id +
 * is_profile_complete, role-independent — so an admin who is also enrolled in
 * that batch still gets their own batch's announcements. Filtering on
 * role="student" there would silently drop them.
 *
 * College-wide and platform-wide scopes keep the role filter: they mean "the
 * student body", and staff who merely have a college set (item #103's example:
 * an admin account) never registered and are not an audience for a student notice.
 */
async function resolveRecipients(
  db: SupabaseClient,
  college: string,
  batchId: string | null,
): Promise<Array<{ id: string }>> {
  let q = db.from("profiles").select("id").not("phone", "is", null);
  if (batchId) {
    q = q.eq("batch_id", batchId).eq("is_profile_complete", true);
  } else {
    q = q.eq("role", "student");
    if (college !== "all") q = q.eq("college", college);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Array<{ id: string }>;
}

export async function createAnnouncement(
  db: SupabaseClient,
  input: AnnouncementInput,
  createdBy: string | null,
  scopeLabel?: string,
): Promise<AnnouncementResult> {
  const { data: ann, error } = await db
    .from("announcements")
    .insert({
      title: input.title,
      body: input.body,
      college: input.college,
      batch_id: input.batch_id,
      priority: input.priority,
      expires_at: input.expires_at ?? null,
      attachment_url: input.attachment_url ?? null,
      attachment_name: input.attachment_name ?? null,
      created_by: createdBy,
    })
    .select()
    .single();
  if (error) throw error;

  const scope = scopeLabel ?? (input.batch_id ? "Your batch" : input.college === "all" ? "All colleges" : input.college);
  const urgentTag = input.priority === "urgent" ? "🔴 <b>URGENT</b>\n" : "";
  const attachmentLine = input.attachment_name ? ` · 📎 ${escapeHtml(input.attachment_name)}` : "";
  const studentMsg = `${urgentTag}📢 <b>${escapeHtml(input.title)}</b>\n\n${escapeHtml(input.body)}\n\n<i>${scope}${attachmentLine}</i>`;
  const adminMsg = `${studentMsg}\n\n<i>You posted this announcement.</i>`;

  const recipients = await resolveRecipients(db, input.college, input.batch_id);

  // pushSent is REAL delivery now: it counts only recipients whose push
  // actually arrived. Before this fix it counted every recipient, because
  // notifyStudent returned void and never reported a failed push — so an
  // announcement could report "push sent: 150" while zero phones buzzed.
  // Fan out with bounded concurrency. The old sequential loop took ~15s for
  // 161 recipients even when every push failed fast (~100ms each). Once pushes
  // work again each live send is slower, and a sequential sweep of the whole
  // student list risks hitting the serverless time limit and silently cutting
  // off the tail of the list. Ten in flight keeps it well inside the limit
  // without hammering the push service.
  let pushSent = 0;
  let pushFailed = 0;
  let pushNoSubscription = 0;
  let inboxSaved = 0;
  let next = 0;
  async function deliverOne() {
    while (next < recipients.length) {
      const r = recipients[next++];
      try {
        const delivery = await notifyStudent(db, r.id, "announcement", studentMsg, ann.id, { url: "/dashboard" });
        inboxSaved++;
        if (delivery.delivered) pushSent++;
        else if (delivery.attempted) {
          pushFailed++;
          console.error("[services/announcements] push failed for student", r.id, delivery.reason, delivery.statusCode ?? "");
        } else pushNoSubscription++;
      } catch (e) {
        pushFailed++;
        console.error("[services/announcements] student notification failed", r.id, e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(10, recipients.length) }, () => deliverOne()));

  return { announcement: ann, pushSent, pushFailed, pushNoSubscription, inboxSaved, recipients: recipients.length };
}
