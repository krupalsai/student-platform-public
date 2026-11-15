import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText, sendWhatsAppCtaButton } from "@/lib/whatsapp/client";
import { normalizePhone } from "@/lib/services/students";

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface ModRow { phone: string; last_message_at: string | null; permanently_restricted: boolean | null }

/**
 * FREE-ONLY broadcasts (owner rule, 2026-10-26): no paid WhatsApp template is
 * used anywhere in the platform. A broadcast sends free-form text ONLY to
 * students inside Meta's 24h window; everyone outside it is counted as not
 * reached, never billed. The paid broadcast template ("broadcast_update") and
 * its resolver/guard were removed from the platform on 2026-10-26.
 *
 * Shared send loop for every broadcast below — resolves who's inside Meta's
 * 24h free-form window and tallies the result the same way regardless of
 * which recipient list or message shape called it. `sendFreeForm` lets each
 * caller send its own message shape (plain text vs a CTA button) through the
 * same counting logic instead of copy-pasting the loop per caller.
 */
async function sendToRecipients(
  recipients: ModRow[],
  sendFreeForm: (phone: string) => Promise<boolean>,
): Promise<BroadcastResult> {
  const result: BroadcastResult = {
    total: recipients.length,
    inWindow: 0, outOfWindow: 0,
    sentFreeForm: 0, failed: 0, skippedRestricted: 0,
  };

  const cutoff = Date.now() - WINDOW_MS;

  for (const r of recipients) {
    // Someone banned for abuse should not receive broadcasts — being silenced
    // and still messaged is incoherent.
    if (r.permanently_restricted) { result.skippedRestricted++; continue; }
    if (!r.phone) continue;

    const lastMs = r.last_message_at ? new Date(r.last_message_at).getTime() : 0;
    const inWindow = lastMs > cutoff;
    if (inWindow) result.inWindow++; else result.outOfWindow++;

    let ok = false;
    if (inWindow) {
      ok = await sendFreeForm(r.phone);
      if (ok) result.sentFreeForm++;
    }
    // Out-of-window is "not reached", not a failure — it is already counted
    // in outOfWindow above. There is no template fallback: paid templates
    // were removed from the platform (free-only rule).
    if (!ok && inWindow) result.failed++;
  }

  return result;
}

/**
 * Resolves one batch's own enrolled students to their whatsapp_moderation
 * rows (phone, last_message_at, permanently_restricted), for the two
 * batch-scoped broadcasts below. Enrolment matches services/enrollment.ts
 * (item #103): batch_id ALONE isn't enough — a bare batch_id can be an
 * abandoned registration attempt (item #55) that never finished the form and
 * has no business receiving a batch-specific update.
 */
async function batchModerationRows(db: SupabaseClient, batchId: string): Promise<ModRow[]> {
  const { data: students } = await db
    .from("profiles")
    .select("phone")
    .eq("batch_id", batchId)
    .eq("is_profile_complete", true)
    .not("phone", "is", null);

  const phones = Array.from(
    new Set((students ?? []).map((s: { phone: string | null }) => s.phone).filter(Boolean))
  ) as string[];
  if (phones.length === 0) return [];

  const normalized = phones.map((p) => normalizePhone(p));
  const { data: modRows } = await db
    .from("whatsapp_moderation")
    .select("phone, last_message_at, permanently_restricted")
    .in("phone", normalized);

  const modByPhone = new Map(
    (modRows ?? []).map((r: ModRow) => [r.phone, r])
  );

  // One row per real phone, even for a student whose number has never
  // messaged the bot (no whatsapp_moderation row at all) — they still count
  // toward `total`/`outOfWindow`, they just can't receive anything without
  // messaging first, same as everyone else out of window.
  return phones.map((phone, i) => {
    const mod = modByPhone.get(normalized[i]);
    return {
      phone,
      last_message_at: mod?.last_message_at ?? null,
      permanently_restricted: mod?.permanently_restricted ?? false,
    };
  });
}

/**
 * WhatsApp broadcast — to everyone who has ever messaged the bot.
 *
 * The recipient list is whatsapp_moderation, which holds one row per person
 * who has written to the bot (keyed by the 10-digit phone form — never the +91
 * form, see bug #29).
 *
 * The hard constraint this is built around: Meta permits a free-form message
 * ONLY within 24 hours of that person's own last message. Outside it, nobody
 * is reached — there is no paid template anymore (free-only rule). Reporting
 * "sent to 47" when 47 sends failed is the one outcome worth engineering
 * against, so the result states both counts separately.
 */

export interface BroadcastResult {
  total: number;
  inWindow: number;
  outOfWindow: number;
  sentFreeForm: number;
  failed: number;
  skippedRestricted: number;
}

export async function broadcastWhatsApp(
  db: SupabaseClient,
  message: string,
): Promise<BroadcastResult> {
  const { data } = await db
    .from("whatsapp_moderation")
    .select("phone, last_message_at, permanently_restricted");

  return sendToRecipients(
    (data ?? []) as ModRow[],
    (phone) => sendWhatsAppText(phone, message),
  );
}

/**
 * Free-text broadcast scoped to ONE batch's own enrolled students — for
 * anything that names a specific batch (a payment tally, a batch-specific
 * update), where broadcastWhatsApp's whole-platform reach is actively wrong:
 * live-reported with a screenshot of a BIET waitlist student receiving a
 * "GNITC Batch 1: 8 of 45 have paid, pay your ₹2,200" message for a batch and
 * college he isn't even in. "broadcast has to be batch wise not to everyone."
 */
export async function broadcastWhatsAppToBatch(
  db: SupabaseClient,
  batchId: string,
  message: string,
): Promise<BroadcastResult> {
  const recipients = await batchModerationRows(db, batchId);

  return sendToRecipients(
    recipients,
    (phone) => sendWhatsAppText(phone, message),
  );
}

/**
 * Install-app prompt, scoped to one batch — e.g. "GNIT Batch 1 never got told
 * to install the Student App." Same 24h-window rule as broadcastWhatsApp
 * above, but the recipient list is the batch's own profiles.phone, not
 * everyone who has ever messaged the bot — this is a closed batch's students
 * specifically, not a platform-wide send.
 */
export async function broadcastInstallToBatch(
  db: SupabaseClient,
  batchId: string,
): Promise<BroadcastResult> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(/\/$/, "");
  const installUrl = `${appUrl}/install`;
  const body =
    "📲 *Install the Student App*\n\nTap below to install the Student Platform app on your phone — it's the fastest way to check your payment status, Route Map, and updates.";

  const recipients = await batchModerationRows(db, batchId);

  return sendToRecipients(
    recipients,
    (phone) => sendWhatsAppCtaButton(phone, body, "Install Student App", installUrl, "Student Platform"),
  );
}

/**
 * Sends one batch's WhatsApp group invite to the students already IN that
 * batch.
 *
 * The invite otherwise only rides along with a registration link (item #119),
 * which means it reaches new registrations and nobody who registered earlier —
 * the same forward-only shape as item #108's payment announcements. This is
 * the catch-up, and it is admin-triggered on purpose: it messages every
 * enrolled student, which is not something to fire automatically.
 */
export async function broadcastGroupLinkToBatch(
  db: SupabaseClient,
  batchId: string,
): Promise<BroadcastResult & { noLink?: true }> {
  const { data: batch } = await db
    .from("batches")
    .select("name, whatsapp_group_link")
    .eq("id", batchId)
    .maybeSingle();

  const link = batch?.whatsapp_group_link ?? null;
  if (!link) {
    return {
      total: 0, inWindow: 0, outOfWindow: 0,
      sentFreeForm: 0, failed: 0, skippedRestricted: 0,
      noLink: true,
    };
  }

  const body =
    `👥 *${batch!.name} WhatsApp group*\n\nJoin your batch's group — that is where updates and questions for your batch go.`;

  const recipients = await batchModerationRows(db, batchId);

  return sendToRecipients(
    recipients,
    (phone) => sendWhatsAppCtaButton(phone, body, "Join Group", link, "Student Platform"),
  );
}

/** Human-readable outcome. Deliberately explicit about what did NOT go out. */
export function broadcastSummary(r: BroadcastResult): string {
  const lines = [
    `📢 *Broadcast result*`,
    ``,
    `Recipients considered: *${r.total}*`,
    `✅ Sent now (within 24h): *${r.sentFreeForm}*`,
  ];

  if (r.outOfWindow > 0) {
    lines.push(
      `⚠️ *${r.outOfWindow} not reached* — they last messaged more than 24 hours ago.`,
      ``,
      `WhatsApp only allows a free message within 24 hours of *their* last message. No paid template is in use (free-only).`,
    );
  }

  if (r.failed > 0)          lines.push(`❌ Failed: *${r.failed}*`);
  if (r.skippedRestricted>0) lines.push(`🚫 Skipped (restricted): *${r.skippedRestricted}*`);

  return lines.join("\n");
}
