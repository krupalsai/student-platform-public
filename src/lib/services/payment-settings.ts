import { SupabaseClient } from "@supabase/supabase-js";

export interface UpiDetails {
  upi_id: string | null;
  upi_name: string;
}

export async function resolveUpiDetails(
  db: SupabaseClient,
  batch: { upi_id?: string | null; upi_name?: string | null } | null | undefined,
): Promise<UpiDetails> {
  if (batch?.upi_id) {
    return { upi_id: batch.upi_id, upi_name: batch.upi_name || "Fee Payment" };
  }
  const { data } = await db
    .from("app_settings")
    .select("key, value")
    .in("key", ["upi_id", "upi_payee_name"]);
  const settings: Record<string, string> = {};
  for (const row of data ?? []) settings[row.key] = row.value;
  return { upi_id: settings.upi_id ?? null, upi_name: settings.upi_payee_name || "Fee Payment" };
}

/** Master switch for student Cashfree payments. Defaults OFF until explicitly enabled. */
export async function isCashfreeEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "cashfree_enabled")
    .maybeSingle();
  return data?.value === "true";
}

/** Master switch for student Razorpay payments. Defaults OFF until explicitly enabled. */
export async function isRazorpayEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "razorpay_enabled")
    .maybeSingle();
  return data?.value === "true";
}

/**
 * Master switch for student PhonePe payments. Defaults OFF until explicitly
 * enabled.
 *
 * History, so the next session doesn't "fix" this back to hardcoded false:
 * item #90 hardcoded this false when Cashfree became the only gateway; item
 * #95 then deleted the PhonePe integration entirely on that basis. A later,
 * unreviewed external commit silently restored it as a DB toggle without a
 * real decision behind it, and a security audit (2026-09-27, item #177)
 * deleted it again on the assumption item #95's rule still held. It was
 * restored a THIRD time, deliberately, in item #178 — the admin explicitly
 * asked for PhonePe, Cashfree and Razorpay to all be real, independently
 * switchable gateways (Razorpay has a free-tier transaction cap that starts
 * charging once exceeded; PhonePe's free tier has its own fund-receipt
 * issues) so they can flip between whichever is currently viable without a
 * code change. This is now the genuine, current design — see
 * `getActivePaymentGateway()` below for the single place that decides which
 * one is actually live.
 */
export async function isPhonePeEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "phonepe_enabled")
    .maybeSingle();
  return data?.value === "true";
}

export type PaymentGateway = "razorpay" | "cashfree" | "phonepe";

/**
 * The single place that decides which ONE gateway is actually live for new
 * payment attempts. `/pay/[slug]` and every `/api/<gateway>/initiate` route
 * must agree with this function — never decide independently, or a student
 * can be shown a button for a gateway the admin just turned off (the exact
 * bug found in item #178: `/pay/[slug]` was hardcoded to Razorpay and never
 * consulted any of these three switches at all).
 *
 * The admin Settings UI is expected to keep these mutually exclusive (only
 * one ON at a time), but this function defends against a bad state anyway:
 * if more than one is somehow ON, it picks by a fixed priority order
 * (Razorpay > Cashfree > PhonePe) rather than picking unpredictably, and
 * logs it so a stuck-on-two-gateways state is visible instead of silent.
 * Returns null when none are enabled — the UI must show "payments
 * unavailable," never fall back to a hardcoded gateway.
 */
export async function getActivePaymentGateway(db: SupabaseClient): Promise<PaymentGateway | null> {
  const { data } = await db
    .from("app_settings")
    .select("key, value")
    .in("key", ["razorpay_enabled", "cashfree_enabled", "phonepe_enabled"]);
  const settings: Record<string, string> = {};
  (data ?? []).forEach((r: { key: string; value: string }) => { settings[r.key] = r.value; });

  const razorpayOn = settings.razorpay_enabled === "true";
  const cashfreeOn = settings.cashfree_enabled === "true";
  const phonepeOn = settings.phonepe_enabled === "true";

  const onCount = [razorpayOn, cashfreeOn, phonepeOn].filter(Boolean).length;
  if (onCount > 1) {
    console.error(
      `[payment-settings] more than one gateway is enabled at once (razorpay=${razorpayOn} cashfree=${cashfreeOn} phonepe=${phonepeOn}) — picking by priority order. Turn off the extra ones in admin Settings.`,
    );
  }

  if (razorpayOn) return "razorpay";
  if (cashfreeOn) return "cashfree";
  if (phonepeOn) return "phonepe";
  return null;
}

// Checked on essentially every single non-admin WhatsApp message
// (router.ts), so an uncached read here is a DB round trip on every message
// a student sends — for a flag an admin flips maybe once in a great while.
// A short TTL keeps a real admin toggle taking effect within the same
// ballpark as before, while removing that round trip from the common case.
let botEnabledCache: { value: boolean; expiresAt: number } | null = null;
const BOT_ENABLED_CACHE_TTL_MS = 30 * 1000;

export async function isWhatsAppBotEnabled(db: SupabaseClient): Promise<boolean> {
  const now = Date.now();
  if (botEnabledCache && botEnabledCache.expiresAt > now) return botEnabledCache.value;

  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "whatsapp_bot_enabled")
    .maybeSingle();
  const value = data?.value !== "false";
  botEnabledCache = { value, expiresAt: now + BOT_ENABLED_CACHE_TTL_MS };
  return value;
}

export async function isRouteMapEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "route_map_enabled")
    .maybeSingle();
  return data?.value !== "false";
}

/**
 * Posts a "<name> just paid — N of M have now paid" notice into the batch
 * Discussion on every approval (services/payment-announcements.ts). Defaults
 * ON like the other student-facing toggles, but exists as its own switch
 * because it names individual students publicly to their whole batch — if
 * that ever needs to stop, it must be stoppable without a redeploy and
 * without taking the whole chat down.
 */
export async function isPaymentAnnouncementsEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "payment_announcements_enabled")
    .maybeSingle();
  return data?.value !== "false";
}

/**
 * WhatsApp/push nudge to a batch's UNPAID students when a classmate pays
 * (services/payment-announcements.ts). Separate from the in-chat notice
 * because the blast radius is completely different: the chat notice is
 * passive, this pushes to every unpaid student's phone. Rate-limited to one
 * per student per day in code, but this is the switch that stops it outright.
 */
export async function isPaymentNudgeEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "payment_nudge_enabled")
    .maybeSingle();
  return data?.value !== "false";
}

/**
 * In-app student ⇄ admin voice calls (migration 0075).
 *
 * Defaults ON, same fail-open posture as route_map_enabled / group_chat_enabled:
 * a hiccup reading app_settings must not silently cut students off from support.
 * Turn it off from admin Settings when nobody is available to answer.
 */
export async function isVoiceCallsEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "voice_calls_enabled")
    .maybeSingle();
  return data?.value !== "false";
}

export async function isGroupChatEnabled(db: SupabaseClient): Promise<boolean> {
  const { data } = await db
    .from("app_settings")
    .select("value")
    .eq("key", "group_chat_enabled")
    .maybeSingle();
  return data?.value !== "false";
}

/** Builds the legacy UPI link for non-payment features that may still need it. */
export function buildUpiLink(upi: UpiDetails, feeAmount: number, referenceNote?: string): string | null {
  if (!upi.upi_id) return null;
  const params = new URLSearchParams({
    pa: upi.upi_id,
    pn: upi.upi_name,
    am: String(Math.round(feeAmount)),
    cu: "INR",
  });
  if (referenceNote) params.set("tn", referenceNote);
  return `upi://pay?${params.toString()}`;
}
