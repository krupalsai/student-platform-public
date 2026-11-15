import { SupabaseClient } from "@supabase/supabase-js";
import { listWaiting, markProcessed } from "@/lib/services/waitlist";
import { issueRegistrationToken, buildRegistrationLink } from "@/lib/registration-token";
import { sendGroupLinkIfSet } from "@/lib/whatsapp/group-link";
import { sendWhatsAppCtaButton } from "@/lib/whatsapp/client";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";
import { getCollegeName } from "@/lib/services/colleges";

/**
 * Called after a batch transitions to 'active' for a college. Sends
 * registration links to everyone on that college's waiting list, in FIFO
 * order, and marks them processed.
 *
 * Best-effort per student: a failure sending to one student doesn't block
 * the rest, and that student is NOT marked processed — they stay on the
 * queue so a retry (next activation, or manual admin follow-up) can still
 * reach them, rather than silently dropping them for a transient send
 * failure.
 */
export async function processWaitlistForCollege(
  db: SupabaseClient,
  college: string,
): Promise<{ processed: number; failed: number }> {
  const waiting = await listWaiting(db, college);
  if (!waiting.length) return { processed: 0, failed: 0 };

  const collegeName = await getCollegeName(db, college);
  const processedIds: string[] = [];
  let failed = 0;

  for (const entry of waiting) {
    try {
      const issued = await issueRegistrationToken(db, entry.phone, college);
      if (!issued) {
        // Shouldn't happen right after activation (a batch now exists),
        // but don't let one odd case abort the rest of the queue.
        failed++;
        continue;
      }
      const link = buildRegistrationLink(issued);
      // A tappable button, matching the "Open Student App" message students
      // already get elsewhere — a bare URL pasted into the body reads like a
      // forwarded link and is easy to mistrust or mis-tap. sendWhatsAppCtaButton
      // falls back to text-with-URL by itself if the account can't render a
      // cta_url, so this is never worse than what it replaces.
      await sendWhatsAppCtaButton(
        normalizeWhatsAppNumber(entry.phone),
        `🎉 Good news! Registration is now open for *${collegeName}*.\n\n` +
          `Tap below to fill in your details and complete your registration — it takes just a few minutes.`,
        "Start Registration",
        link,
      );
      await sendGroupLinkIfSet(db, normalizeWhatsAppNumber(entry.phone), college);
      processedIds.push(entry.id);
    } catch (e) {
      failed++;
      console.error(`[waitlist-processing] failed to notify waitlist entry ${entry.id}:`, e);
    }
  }

  await markProcessed(db, processedIds);
  return { processed: processedIds.length, failed };
}
