import { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppCtaButton } from "@/lib/whatsapp/client";
import { getCurrentActiveBatch } from "@/lib/services/batches";

/**
 * The batch's WhatsApp group invite link, sent alongside the registration
 * link.
 *
 * WHY THE BOT DOES NOT CREATE THE GROUP: Meta's Groups API (verified against
 * developers.facebook.com/documentation/business-messaging/whatsapp/groups)
 * requires an Official Business Account and caps a group at EIGHT
 * participants, with no endpoint to add someone directly. A batch here runs to
 * 45+ students, so an API-created group is not usable for this at all. An
 * admin creates a normal WhatsApp group (1024 participants) and stores its
 * invite link with GROUP LINK <batch>: <url>.
 *
 * Do not "fix" this by reaching for the Groups API — the 8-participant cap is
 * Meta's, not something this app can raise.
 */

/** Only a real WhatsApp group invite. Anything else would be blasted to every
 *  new student, so a typo must fail here rather than in their chat. */
export const GROUP_LINK_RE = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{6,}$/;

export function isValidGroupLink(url: string): boolean {
  return GROUP_LINK_RE.test(url.trim());
}

export async function getGroupLinkForCollege(
  db: SupabaseClient,
  college: string,
): Promise<{ link: string; batchName: string } | null> {
  const batch = await getCurrentActiveBatch(db, college).catch(() => null);
  if (!batch) return null;
  const { data } = await db
    .from("batches")
    .select("name, whatsapp_group_link")
    .eq("id", batch.id)
    .maybeSingle();
  const link = data?.whatsapp_group_link;
  if (!link || !isValidGroupLink(link)) return null;
  return { link, batchName: data!.name as string };
}

/**
 * Sent as a SECOND message, after the registration link.
 *
 * One message cannot carry two buttons, and the registration link is the step
 * that actually matters — burying it under a group invite would trade a
 * completed registration for a group join. Best-effort: a missing or failed
 * group link must never break the registration send that preceded it.
 */
export async function sendGroupLinkIfSet(
  db: SupabaseClient,
  waTo: string,
  college: string,
): Promise<boolean> {
  try {
    const group = await getGroupLinkForCollege(db, college);
    if (!group) return false;
    await sendWhatsAppCtaButton(
      waTo,
      `You can also join the *${group.batchName}* WhatsApp group — that is where updates and questions for your batch go.`,
      "Join Group",
      group.link,
    );
    return true;
  } catch (e) {
    console.error("[group-link] failed to send group invite", e);
    return false;
  }
}
