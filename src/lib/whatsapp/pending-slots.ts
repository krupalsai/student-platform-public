/**
 * Shared slot-filling state for WhatsApp questions that need more than one
 * message. Each flow declares the slots it needs (e.g. intent "paid_count"
 * needs college + batch). When the bot asks for a missing slot, the answers
 * already given are saved here. The next reply fills the remaining slots and
 * the question is answered once everything is known.
 *
 * Single source of truth for multi-step state. Flows must not invent their own
 * last_intent strings for this. Rows expire after TTL_MS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/services/students";

export type SlotValue = string | number | null;
export type Slots = Record<string, SlotValue>;

const TTL_MS = 30 * 60 * 1000;

export async function savePending(db: SupabaseClient, phone: string, intent: string, slots: Slots): Promise<void> {
  await db.from("whatsapp_moderation").upsert({
    phone: normalizePhone(phone),
    pending_intent: intent,
    pending_slots: slots,
    pending_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: "phone" });
}

/** Returns the saved slots for this intent, or null if none, expired or another intent. */
export async function loadPending(db: SupabaseClient, phone: string, intent: string): Promise<Slots | null> {
  const { data } = await db
    .from("whatsapp_moderation")
    .select("pending_intent, pending_slots, pending_at")
    .eq("phone", normalizePhone(phone))
    .maybeSingle();
  if (!data?.pending_intent || data.pending_intent !== intent || !data.pending_at) return null;
  if (Date.now() - new Date(data.pending_at).getTime() > TTL_MS) return null;
  return (data.pending_slots as Slots) ?? null;
}

export async function clearPending(db: SupabaseClient, phone: string): Promise<void> {
  await db.from("whatsapp_moderation").update({ pending_intent: null, pending_slots: null, pending_at: null }).eq("phone", normalizePhone(phone));
}

/** New values fill empty slots; a value already known is kept unless the new one is non-empty. */
export function mergeSlots(previous: Slots | null, fresh: Slots): Slots {
  const out: Slots = { ...(previous ?? {}) };
  for (const [k, v] of Object.entries(fresh)) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

export function missingSlots(slots: Slots, required: string[]): string[] {
  return required.filter(k => slots[k] === null || slots[k] === undefined || slots[k] === "");
}
