/**
 * Missed-call lead collection (migration 0094, docs/missed-call-leads.md).
 *
 * Self-contained module for the "missed call → WhatsApp lead" flow:
 *   1. POST /api/missed-call creates a lead row (step 'problem') and the
 *      route sends the caller a WhatsApp greeting.
 *   2. The caller's replies arrive on the normal WhatsApp webhook, which
 *      calls handleMissedCallLeadMessage() BEFORE the student router.
 *   3. The chat walks need → area → name → urgency; on the last answer the
 *      lead is complete and the owner (super admin) is notified on WhatsApp.
 *
 * Safety for the existing bot — the hook only ever handles a message when
 * ALL of these hold, and returns false (normal bot runs, untouched) otherwise:
 *   - the sender has NO profile in `profiles` (not a registered student),
 *   - the sender is NOT a WhatsApp admin (admins table / WHATSAPP_ADMIN_NUMBER),
 *   - the sender has an OPEN missed-call lead (step != 'done').
 * A lead only exists if a missed call was reported (detector) or an admin
 * simulated one, so ordinary newcomers messaging the bot are never captured.
 *
 * If the missed_call_leads table doesn't exist yet (migration not pasted),
 * every function here degrades to "not handled" / 'missing_table' instead of
 * throwing — the student bot keeps working exactly as before.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { normalizePhone } from "@/lib/services/students";

export const LEAD_STATUSES = ["New", "Contacted", "In progress", "Completed", "Lost"] as const;

const TABLE = "missed_call_leads";
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

type Lead = {
  id: string;
  caller_phone: string;
  caller_name: string | null;
  need: string | null;
  area: string | null;
  urgency: string | null;
  status: string;
  step: string;
  created_at: string;
};

/** True when a Supabase error is just "the 0094 migration hasn't been pasted yet". */
export function isMissingLeadsTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; message?: string };
  const msg = e.message ?? "";
  if (!msg.includes(TABLE)) return false;
  return e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(msg);
}

/** Registered students and WhatsApp admins must NEVER be captured by the lead flow. */
export async function isRegisteredOrAdmin(db: SupabaseClient, phone10: string): Promise<boolean> {
  const envAdmin = normalizePhone(process.env.WHATSAPP_ADMIN_NUMBER ?? "");
  if (envAdmin && envAdmin === phone10) return true;

  const { data: profile } = await db.from("profiles")
    .select("id").eq("phone", phone10).maybeSingle();
  if (profile) return true;

  const { data: waAdmin } = await db.from("admins")
    .select("id").eq("phone", phone10).eq("active", true).maybeSingle();
  return !!waAdmin;
}

async function getOpenLead(db: SupabaseClient, phone10: string): Promise<Lead | null> {
  const { data, error } = await db.from(TABLE)
    .select("id, caller_phone, caller_name, need, area, urgency, status, step, created_at")
    .eq("caller_phone", phone10)
    .neq("step", "done")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    if (!isMissingLeadsTable(error)) console.error("[missed-call-leads] open-lead lookup failed:", error.message);
    return null;
  }
  return (data?.[0] as Lead) ?? null;
}

/**
 * Create a lead for a reported missed call, with a 30-minute dedupe window:
 * repeat calls from the same number while a lead is still open (and recent)
 * do not create a second lead or a second greeting.
 */
export async function startMissedCallLead(
  db: SupabaseClient,
  phone10: string,
  source = "missed_call",
): Promise<{ outcome: "created" | "deduped" | "missing_table"; lead?: Lead }> {
  const open = await getOpenLead(db, phone10);
  if (open && Date.now() - new Date(open.created_at).getTime() < DEDUPE_WINDOW_MS) {
    return { outcome: "deduped", lead: open };
  }

  const { data, error } = await db.from(TABLE)
    .insert({ caller_phone: phone10, status: "New", step: "problem", source })
    .select("id, caller_phone, caller_name, need, area, urgency, status, step, created_at")
    .single();
  if (error) {
    if (isMissingLeadsTable(error)) return { outcome: "missing_table" };
    console.error("[missed-call-leads] lead insert failed:", error.message);
    throw error;
  }
  return { outcome: "created", lead: data as Lead };
}

/** WhatsApp the owner (active SUPER_ADMIN rows; WHATSAPP_ADMIN_NUMBER as fallback). */
async function notifyOwnerOfLead(db: SupabaseClient, lead: Lead): Promise<void> {
  try {
    const phones = new Set<string>();
    const { data } = await db.from("admins")
      .select("phone").ilike("role", "SUPER_ADMIN").eq("active", true);
    for (const r of data ?? []) {
      const p = normalizePhone(String((r as { phone?: string }).phone ?? ""));
      if (p.length === 10) phones.add(p);
    }
    const envAdmin = normalizePhone(process.env.WHATSAPP_ADMIN_NUMBER ?? "");
    if (envAdmin.length === 10) phones.add(envAdmin);
    if (!phones.size) return;

    const text =
      `🆕 *New call lead*\n` +
      `*Name:* ${lead.caller_name ?? "—"}\n` +
      `*Area:* ${lead.area ?? "—"}\n` +
      `*Need:* ${lead.need ?? "—"}\n` +
      `*Urgency:* ${lead.urgency ?? "—"}\n` +
      `*Phone:* +91 ${lead.caller_phone}\n\n` +
      `See Admin → Call Leads.`;
    await Promise.all([...phones].map(p => sendWhatsAppText(p, text)));
  } catch (e) {
    console.error("[missed-call-leads] owner notify failed:", e);
  }
}

/**
 * Handle one inbound WhatsApp message as part of a missed-call lead chat.
 * Returns true when the message was consumed by the lead flow (the caller
 * must NOT also go through the student router); false to fall through.
 */
export async function handleMissedCallLeadMessage(
  db: SupabaseClient,
  rawPhone: string,
  text: string | null,
): Promise<boolean> {
  try {
    const phone10 = normalizePhone(rawPhone ?? "");
    const body = (text ?? "").trim();
    if (phone10.length !== 10 || !body) return false;

    if (await isRegisteredOrAdmin(db, phone10)) return false;

    const lead = await getOpenLead(db, phone10);
    if (!lead) return false;

    const now = new Date().toISOString();
    const patch = async (fields: Record<string, unknown>) => {
      const { error } = await db.from(TABLE)
        .update({ ...fields, updated_at: now }).eq("id", lead.id);
      if (error) console.error("[missed-call-leads] lead update failed:", error.message);
    };

    // Opt-out at any step: close the lead as Lost and stop messaging.
    if (/^stop\b/i.test(body)) {
      await patch({ step: "done", status: "Lost" });
      await sendWhatsAppText(phone10, "Okay — we won't message you again. Take care!");
      return true;
    }

    switch (lead.step) {
      case "problem": {
        await patch({ need: body, step: "area" });
        await sendWhatsAppText(phone10, "Got it. Which area are you from?");
        return true;
      }
      case "area": {
        await patch({ area: body, step: "name" });
        await sendWhatsAppText(phone10, "Thanks. What's your name?");
        return true;
      }
      case "name": {
        await patch({ caller_name: body, step: "urgency" });
        await sendWhatsAppText(phone10, "Last one — how urgent is this? (Today / This week / Just enquiring)");
        return true;
      }
      case "urgency": {
        await patch({ urgency: body, step: "done" });
        const name = lead.caller_name ?? "there";
        await sendWhatsAppText(phone10, `Thanks ${name} — we've noted it and will call you back shortly.`);
        await notifyOwnerOfLead(db, { ...lead, urgency: body, step: "done" });
        return true;
      }
      default:
        return false;
    }
  } catch (e) {
    // Never let the lead flow break the student bot — fall through instead.
    console.error("[missed-call-leads] handler failed, falling through to router:", e);
    return false;
  }
}
