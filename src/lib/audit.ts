import { createServiceClient } from "@/lib/supabase/server";

export type AuditAction =
  | "user.created" | "user.role_changed"

  | "payment.submitted" | "payment.approved" | "payment.rejected"
  | "payment.reupload_requested" | "payment.invite_sent" | "payment.invite_failed"
  | "payment.pg_cancelled_by_student" | "payment.pg_reconciled" | "payment.pg_initiated"
  | "payment.pg_signature_failed"
  | "payment.amount_mismatch" | "payment.pg_webhook" | "payment.upi_webhook"
  | "profile.completed" | "profile.updated" | "profile.correction"
  | "batch.created" | "batch.updated" | "batch.deleted" | "batch.status_changed"
  | "college.created"
  | "student.deleted" | "student.college_or_details_edited" | "student.document_uploaded_by_admin" | "session.created"
  | "student.college_id_reuploaded" | "query.submitted"
  | "user.removed" | "batch.auto_closed" | "batch.ended" | "batch.students_transferred"
  | "group_message.deleted" | "whatsapp.broadcast"
  | "support.submitted" | "support.reply_submitted" | "support.team_replied" | "support.resolved"
  | "student.created_by_admin"
  | "ops_digest.sent"
  | "whatsapp.calling_settings_changed"
  | "code.fix_applied"


export async function audit(
  action: AuditAction,
  targetType: string,
  targetId: string | null,
  meta: Record<string, unknown> = {},
  actorId?: string,
  actorRole?: string
): Promise<void> {
  try {
    const db = createServiceClient();
    const { error } = await db.from("audit_logs").insert({
      actor_id: actorId ?? null,
      actor_role: actorRole ?? "system",
      action,
      target_type: targetType,
      target_id: targetId,
      meta,
    });
    if (error) {
      console.error("[audit] insert failed", { action, targetType, targetId, error });
    }
  } catch (err) {
    console.error("[audit] threw", { action, targetType, targetId, err });
  }
}
