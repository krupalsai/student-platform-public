/**
 * "Hall is live" alerts — the server-side half of the live-video feature.
 *
 * The case card (CaseStatusCard) already polls every 5 minutes while it is
 * OPEN, but a student with the app closed hears nothing when their judge's
 * hall starts streaming. This module closes that gap: a scheduled job calls
 * checkAndAlertHallLive() every ~10 minutes during court hours; for every
 * batch whose case is listed today and whose matched hall is streaming RIGHT
 * NOW, it WhatsApps each of the batch's students (WhatsApp is the channel
 * every student already has — OTP login and the support bot both run on it).
 * Students inside Meta's 24h window get free-form text; everyone else is
 * not reached — broadcasts are free-only, no paid template is in use.
 *
 * Exactly-once per batch per day: the first run that sees the hall streaming
 * writes a hall_live_alerts row; later runs see it and stay quiet, so a hall
 * flapping offline/online doesn't spam anyone.
 *
 * Fail-soft like everything else here: no phones on file, or a dead board
 * endpoint all just mean "no alerts sent", never an exception.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getBatchCaseStatus, isDateTodayIST } from "@/lib/services/court-case";
import { getLiveHallForJudges } from "@/lib/services/live-halls";
import { broadcastWhatsAppToBatch } from "@/lib/whatsapp/broadcast";

/** YYYY-MM-DD in IST — the alert's dedup grain is a court day, not UTC. */
function todayIST(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface HallLiveAlertResult {
  batchSlug: string;
  hallName: string;
  studentsReached: number;
  studentsTotal: number;
  skipped?: string;
}

export async function checkAndAlertHallLive(
  db: SupabaseClient
): Promise<{ date: string; results: HallLiveAlertResult[] }> {
  const date = todayIST();
  const results: HallLiveAlertResult[] = [];

  const { data: batches, error: batchErr } = await db
    .from("batches")
    .select("id, slug, case_type, case_number, case_year")
    .not("case_number", "is", null);
  if (batchErr) {
    console.error("[hall-live-alert] batch list failed", batchErr.message);
    return { date, results };
  }

  for (const batch of batches ?? []) {
    try {
      const { available, status } = await getBatchCaseStatus(db, batch.slug);
      // Same "listed today" rule the card uses: server flag, else re-derived
      // from the raw listing date so a stale cache row can't skip a batch.
      const listedToday = status?.listedToday ?? isDateTodayIST(status?.listingDate);
      if (!available || !status || !listedToday || status.status === "DISPOSED") continue;

      const hall = await getLiveHallForJudges(status.judges);
      if (!hall || !hall.streaming) continue;

      const { data: already } = await db
        .from("hall_live_alerts")
        .select("id")
        .eq("batch_slug", batch.slug)
        .eq("alert_date", date)
        .maybeSingle();
      if (already) {
        results.push({ batchSlug: batch.slug, hallName: hall.hallName, studentsReached: 0, studentsTotal: 0, skipped: "already_alerted_today" });
        continue;
      }

      const caseNo = [batch.case_type, batch.case_number, batch.case_year].filter(Boolean).join(" ").trim() || "your case";
      const judge = status.judges?.trim() || "the judge";
      const message =
        `🔴 LIVE NOW — ${hall.hallName}\n\n` +
        `${caseNo} is listed today before ${judge}, and the hall just started streaming.\n\n` +
        `Watch the hearing live:\n${hall.watchUrl}`;

      const sent = await broadcastWhatsAppToBatch(db, batch.id, message);
      const reached = sent.sentFreeForm;

      await db.from("hall_live_alerts").insert({
        batch_slug: batch.slug,
        alert_date: date,
        court_code: hall.courtCode,
        hall_name: hall.hallName,
        students_notified: reached,
      });

      results.push({ batchSlug: batch.slug, hallName: hall.hallName, studentsReached: reached, studentsTotal: sent.total });
    } catch (e) {
      console.error("[hall-live-alert] batch failed", batch.slug, (e as Error).message);
    }
  }

  return { date, results };
}

