/**
 * WhatsApp AI-first understanding (item #221).
 *
 * Every free-text student message on WhatsApp now goes to the grounded model
 * FIRST, with that student's real data. The model either answers in words or,
 * when the student clearly wants the bot to DO something, ends its reply with
 * one [[DO:x]] tag. The router runs the matching, already-proven handler —
 * the model never performs an action itself, and only the actions listed
 * here exist. Anything else it writes is dropped.
 *
 * Pure (no I/O) so the tag handling is unit-testable.
 */

import { VERIFIED_FEE_AMOUNTS } from "./knowledge-base";

export const WHATSAPP_ACTIONS = [
  "register",
  "app_login",
  "app_link",
  "payment_status",
  "registration_status",
  "batch_status",
  "petition_status",
  "seat_count",
  "paid_count",
  "menu",
  "contact_support",
  "id_reupload",
] as const;

export type WhatsAppAction = (typeof WHATSAPP_ACTIONS)[number];

const DO_TAG = /\[\[\s*DO\s*:\s*([^\]]*?)\s*\]\]/gi;
/** The in-app [[OPEN:x]] tag means nothing on WhatsApp — strip it if a model emits one. */
const OPEN_TAG = /\[\[\s*OPEN\s*:[^\]]*\]\]/gi;

/** Strips every [[DO:x]] tag and returns the first one that is a real action. */
export function extractWhatsAppAction(text: string): { text: string; action: WhatsAppAction | null } {
  let action: WhatsAppAction | null = null;
  const clean = text
    .replace(DO_TAG, (_m, key: string) => {
      const k = key.trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!action && (WHATSAPP_ACTIONS as readonly string[]).includes(k)) action = k as WhatsAppAction;
      return "";
    })
    .replace(OPEN_TAG, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: clean, action };
}

/**
 * Rule 8 (revised 9 Nov 2026): the WhatsApp bot may quote ONLY the verified
 * batch registration fees — the exact amounts in the `batches` table, listed
 * in knowledge-base.ts as VERIFIED_FEE_AMOUNTS. Any OTHER rupee amount is
 * still blocked, because it would be a guess. The model is told the same
 * rule, and this is the last line of defence on the reply itself.
 */
export function containsUnverifiedRupeeAmount(text: string): boolean {
  const re = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d+)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const amount = Number(m[1].replace(/,/g, ""));
    if (!VERIFIED_FEE_AMOUNTS.includes(amount)) return true;
  }
  return false;
}

/** Blanket check — true when ANY rupee amount is present, verified or not. */
export function containsRupeeAmount(text: string): boolean {
  return /(?:₹|\brs\.?|\binr)\s*\d/i.test(text);
}

