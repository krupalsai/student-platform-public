import { SupabaseClient } from "@supabase/supabase-js";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { BATCH_SEAT_MILESTONE } from "@/lib/config";

/**
 * One-time WhatsApp alert to every active admin the moment a batch's
 * registered-student count first reaches BATCH_SEAT_MILESTONE. Fires from
 * the same place as checkAndNotifyLowSeats (api/profile's registration
 * completion path) — a separate, unrelated alert, not a replacement for it.
 */
export async function checkAndNotifyBatchMilestone(db: SupabaseClient, batchId: string): Promise<void> {
  const { data: batch } = await db
    .from("batches")
    .select("id,name,college,seat_milestone_alert_sent_at")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch || batch.seat_milestone_alert_sent_at) return;

  const { count } = await db
    .from("profiles")
    .select("*", { count: "exact", head: true })
    .eq("batch_id", batchId)
    .eq("is_profile_complete", true); // enrolment rule — see services/enrollment.ts
  const registered = count ?? 0;
  if (registered < BATCH_SEAT_MILESTONE) return;

  // Race guard: only the request whose UPDATE actually matches the
  // still-null row sends the alert. Decided from the returned rows, never
  // from an unchecked call or a bare `count` (item #111's lesson) — two
  // registrations completing back-to-back must not double-notify admins.
  const { data: won } = await db
    .from("batches")
    .update({ seat_milestone_alert_sent_at: new Date().toISOString() })
    .eq("id", batchId)
    .is("seat_milestone_alert_sent_at", null)
    .select("id");
  if (!won || won.length === 0) return;

  const phones = await getActiveAdminPhones(db);
  if (!phones.length) return;
  const message = `🎉 Batch Milestone Reached\n\n${batch.name} (${batch.college}) has reached ${registered} registered students (minimum ${BATCH_SEAT_MILESTONE}).`;
  await Promise.all(phones.map((p) => sendWhatsAppText(p, message).catch(() => false)));
}
