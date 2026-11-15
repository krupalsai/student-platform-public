/**
 * Student event logging service.
 *
 * Thin, best-effort wrapper over student_events. Never throws — a logging
 * failure must never break the main request flow.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type StudentEventType =
  // Authentication / session
  | "session.created"
  // Registration funnel
  | "registration.started"
  | "registration.completed"
  // Payment funnel
  | "payment.page_opened"
  | "payment.initiated"
  | "payment.submitted"
  | "payment.approved"
  | "payment.rejected"
  | "payment.reupload_requested"
  // Dashboard / app usage
  | "dashboard.opened"
  | "route_map.opened"
  | "announcements.opened"
  | "announcement.viewed"
  | "petition.viewed"
  | "documents.viewed"
  | "document.downloaded"
  | "faq.viewed"
  | "settings.opened"
  | "session.ended"
  | "linkedin.post_clicked"
  // Student Support — what students ask, and how it was resolved. The raw
  // material for deciding what to improve next (menu topics, FAQs, screens).
  | "support.asked";

export interface StudentEventInput {
  student_id: string;
  batch_id?: string | null;
  college?: string | null;
  event_type: StudentEventType;
  page?: string | null;
  metadata?: Record<string, unknown>;
}

export async function logStudentEvent(
  db: SupabaseClient,
  event: StudentEventInput
): Promise<void> {
  try {
    const { error } = await db.from("student_events").insert({
      student_id:  event.student_id,
      batch_id:    event.batch_id    ?? null,
      college:     event.college     ?? null,
      event_type:  event.event_type,
      page:        event.page        ?? null,
      metadata:    event.metadata    ?? {},
    });
    if (error) console.error("[student-events] insert failed", { event_type: event.event_type, error });
  } catch (err) {
    console.error("[student-events] threw", { event_type: event.event_type, err });
  }
}
