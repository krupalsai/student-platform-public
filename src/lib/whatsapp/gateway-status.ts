/**
 * Deterministic gateway-status answers for the WhatsApp bot.
 *
 * Answers "Is Cashfree working?" / "Did cashfree pg is working" from the
 * live gateway switches (getActivePaymentGateway) plus recent Cashfree
 * failure evidence — never from the LLM classifier or the FAQ corpus.
 * See gateway-status-text.ts for why: the classifier mapped "is working"
 * to STATUS_REQUEST (Platform Status dump, 2026-10-27) and the nearest FAQ
 * ("Payments go through Razorpay") goes stale the moment the admin flips
 * the switch.
 *
 * Placement matters: the router calls this BEFORE the classifier fallback
 * in the admin branch and BEFORE answerWithAiFirst in the student branch,
 * so it works even when every AI provider is down.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getActivePaymentGateway } from "@/lib/services/payment-settings";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import {
  isGatewayStatusQuestion,
  buildGatewayStatusAnswer,
  type GatewayAudience,
} from "@/lib/whatsapp/gateway-status-text";

/**
 * True when Cashfree recently failed with "transactions are not enabled" —
 * i.e. the merchant account is not activated yet, so the Cashfree switch
 * being ON does not mean Cashfree can take payments. Reads system_errors
 * (the same evidence the 25–27 Oct failures left behind), last 30 days.
 */
async function isCashfreeKnownBroken(db: SupabaseClient): Promise<boolean> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("system_errors")
    .select("created_at")
    .eq("route", "api/cashfree/initiate")
    .ilike("message", "%transactions are not enabled%")
    .gte("created_at", since)
    .limit(1);
  if (error) {
    console.error("[whatsapp/gateway-status] cashfree health check failed:", error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Answers a gateway-status question and returns true when it did — the
 * router returns immediately. Returns false for anything else so the
 * normal pipeline runs unchanged. Never throws.
 */
export async function answerGatewayStatusQuestion(
  db: SupabaseClient,
  waFrom: string,
  text: string,
  audience: GatewayAudience,
): Promise<boolean> {
  if (!isGatewayStatusQuestion(text)) return false;
  try {
    const active = await getActivePaymentGateway(db).catch(() => null);
    const cashfreeBroken =
      active === "cashfree" ? await isCashfreeKnownBroken(db).catch(() => false) : false;
    await sendWhatsAppText(waFrom, buildGatewayStatusAnswer(active, cashfreeBroken, audience));
    return true;
  } catch (e) {
    console.error("[whatsapp/gateway-status] failed:", (e as Error).message);
    return false;
  }
}
