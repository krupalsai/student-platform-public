import { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { normalizePhone } from "@/lib/services/students";
import { getActiveColleges } from "@/lib/services/colleges";
import { createBatch, nextBatchName, setBatchFeeAndActivate } from "@/lib/services/batches";
import { processWaitlistForCollege } from "@/lib/services/waitlist-processing";

/**
 * Admin batch-creation conversation, entirely via WhatsApp text replies —
 * no buttons, so it can't collide with the existing `college_<id>` button
 * namespace used by the student registration flow.
 *
 * State lives in whatsapp_moderation.admin_batch_draft (JSONB), the same
 * table that already tracks one other admin/student conversation flag
 * (awaiting_support_message) — reused rather than a new table, per
 * instruction to only introduce new tables for a genuinely missing
 * capability.
 *
 * Flow: CREATE -> college -> fee -> capacity -> Summary -> YES/EDIT/CANCEL
 *   YES    -> createBatch() (which itself enforces "only one active batch
 *             per college" by pausing rather than replacing an existing
 *             active one) -> if the new batch came out active,
 *             processWaitlistForCollege() -> confirmation reply.
 *   EDIT   -> restarts the wizard from the college step.
 *   CANCEL -> discards the draft.
 */

const CLAIM_STALE_MS = 30 * 60 * 1000;

async function getSetting(db: SupabaseClient, key: string): Promise<string | null> {
  const { data } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function setSetting(db: SupabaseClient, key: string, value: string): Promise<void> {
  await db.from("app_settings").upsert({ key, value });
}
async function clearSetting(db: SupabaseClient, key: string): Promise<void> {
  await db.from("app_settings").delete().eq("key", key);
}
function claimKey(college: string) { return `wa_batch_admin_claim:${college}`; }

/** Claims a college for this admin's conversation, unless another admin
 *  already holds an unstale claim on it. Returns the holder's phone if
 *  blocked, or null if the claim succeeded (or was already this admin's). */
async function tryClaimCollege(db: SupabaseClient, phone: string, college: string): Promise<string | null> {
  const raw = await getSetting(db, claimKey(college));
  if (raw) {
    const claim = JSON.parse(raw) as { phone: string; claimed_at: string };
    const isStale = Date.now() - new Date(claim.claimed_at).getTime() > CLAIM_STALE_MS;
    if (!isStale && claim.phone !== phone) return claim.phone;
  }
  await setSetting(db, claimKey(college), JSON.stringify({ phone, claimed_at: new Date().toISOString() }));
  return null;
}

async function releaseClaim(db: SupabaseClient, college: string): Promise<void> {
  await clearSetting(db, claimKey(college));
}

// "set_fee" is a standalone one-question flow, not part of CREATE: after an
// admin ends a batch, the replacement batch is Active with NO fee, so payments
// stay blocked until it's set. Rather than sending the admin to the website,
// the bot asks for the amount straight away and this step consumes the reply.
type Step = "college" | "fee" | "capacity" | "confirm" | "set_fee" | "set_group_link";

interface BatchDraft {
  step: Step;
  college?: string;
  collegeName?: string;
  fee?: number;
  capacity?: number | null; // null = unlimited
  batchId?: string;         // set_fee / set_group_link — which batch
  batchName?: string;       // set_fee / set_group_link — for the confirmation message
}

async function getDraft(db: SupabaseClient, phone: string): Promise<BatchDraft | null> {
  const { data } = await db.from("whatsapp_moderation").select("admin_batch_draft").eq("phone", phone).maybeSingle();
  return (data?.admin_batch_draft as BatchDraft | null | undefined) ?? null;
}

async function setDraft(db: SupabaseClient, phone: string, draft: BatchDraft | null): Promise<void> {
  await db.from("whatsapp_moderation").upsert({ phone, admin_batch_draft: draft }, { onConflict: "phone" });
}

async function promptCollege(db: SupabaseClient, waFrom: string): Promise<void> {
  const colleges = await getActiveColleges(db);
  if (!colleges.length) {
    await sendWhatsAppText(waFrom, "No colleges are configured. Add one first, then reply CREATE again.");
    return;
  }
  const list = colleges.map(c => `• ${c.id}${c.name !== c.id ? ` — ${c.name}` : ""}`).join("\n");
  await sendWhatsAppText(waFrom, `Which college is this batch for? Reply with the college ID.\n\n${list}`);
}

function summaryText(d: BatchDraft): string {
  return (
    `📋 *New Batch Summary*\n\n` +
    `*College:* ${d.collegeName}\n` +
    `*Fee:* ₹${d.fee}\n` +
    `*Capacity:* ${d.capacity == null ? "Unlimited" : d.capacity}\n\n` +
    `Reply *YES* to create, *EDIT* to start over, or *CANCEL* to abort.`
  );
}

/**
 * Returns true if this message was consumed by the batch-creation flow
 * (either starting it or continuing an in-progress one) — the caller
 * should not try to match it against any other admin command in that case.
 */
/**
 * Asks for the batch's WhatsApp group link, right after the fee.
 *
 * Skipped entirely if one is already set — re-asking on every SETFEE would be
 * noise.
 */
async function promptGroupLink(
  db: SupabaseClient,
  phone: string,
  waFrom: string,
  existing: BatchDraft,
): Promise<void> {
  const { data } = await db.from("batches").select("whatsapp_group_link").eq("id", existing.batchId!).maybeSingle();
  if (data?.whatsapp_group_link) { await setDraft(db, phone, null); return; }

  await setDraft(db, phone, { step: "set_group_link", batchId: existing.batchId, batchName: existing.batchName });
  await sendWhatsAppText(
    waFrom,
    `👥 *WhatsApp group for ${existing.batchName ?? "this batch"}?*\n\n` +
    `Create the group in WhatsApp, then Group info → Invite via link → Copy link, and paste it here.\n\n` +
    `It then goes out with every registration link for this batch. Reply *SKIP* to do it later.`,
  );
}

export async function handleAdminBatchFlow(db: SupabaseClient, waFrom: string, text: string): Promise<boolean> {
  const phone = normalizePhone(waFrom);
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();

  const existing = await getDraft(db, phone);

  // ── set_fee: the bot asked "what's the fee for <new batch>?" — this is the
  //    answer. Handled before everything else so a bare number can't be
  //    misread as some other command.
  // ── set_group_link ────────────────────────────────────────────────────
  // Chained straight after the fee, because opening a batch and creating its
  // WhatsApp group are one job in practice and the group is otherwise
  // remembered only when somebody notices students never got an invite.
  //
  // The bot cannot create the group itself: Meta's Groups API needs an
  // Official Business Account and caps a group at EIGHT participants (the
  // business number occupies one), against batches of 45+. So this asks the
  // admin for the link to a normal group they made.
  if (existing?.step === "set_group_link" && existing.batchId) {
    if (upper === "CANCEL" || upper === "SKIP") {
      await setDraft(db, phone, null);
      await sendWhatsAppText(waFrom, `Okay — no WhatsApp group for *${existing.batchName ?? "this batch"}* yet. Add it any time with *GROUP LINK ${existing.batchName ?? "<batch>"}: <link>*.`);
      return true;
    }
    // Anything that isn't a group link is a different request. Drop the
    // pending question rather than trapping the admin in it — the same
    // subject-change rule the paid-count flow needed (items #114/#117).
    if (!/chat\.whatsapp\.com/i.test(trimmed)) {
      await setDraft(db, phone, null);
      return false;
    }
    const { isValidGroupLink } = await import("@/lib/whatsapp/group-link");
    const url = trimmed.split(/\s+/).find(w => /chat\.whatsapp\.com/i.test(w)) ?? trimmed;
    if (!isValidGroupLink(url)) {
      await sendWhatsAppText(waFrom, "That does not look like a group invite. It should be *https://chat.whatsapp.com/XXXXXXXX* — in the group, tap Group info → Invite via link → Copy link. Reply *SKIP* to do this later.");
      return true;
    }
    const { error } = await db.from("batches").update({ whatsapp_group_link: url }).eq("id", existing.batchId);
    await setDraft(db, phone, null);
    await sendWhatsAppText(
      waFrom,
      error
        ? "❌ Could not save that link. Try again with *GROUP LINK <batch>: <link>*."
        : `✅ Group saved for *${existing.batchName ?? "the batch"}*.\n\nEvery registration link for this batch now comes with the group invite.`,
    );
    return true;
  }

  if (existing?.step === "set_fee" && existing.batchId) {
    if (upper === "CANCEL" || upper === "SKIP" || upper === "STOP") {
      // The fee usually carries over from the batch that just ended, so "skip"
      // often means "keep it" — only say payments are blocked when that is true.
      const { data: kept } = await db.from("batches").select("fee_amount").eq("id", existing.batchId).maybeSingle();
      const keptFee = kept?.fee_amount ? Number(kept.fee_amount) : null;
      await sendWhatsAppText(
        waFrom,
        keptFee
          ? `Okay — *${existing.batchName ?? "the new batch"}* keeps its fee of *₹${keptFee.toLocaleString("en-IN")}*.`
          : `Okay — *${existing.batchName ?? "the new batch"}* still has no fee, so payments stay blocked until you set one. Reply *SETFEE* any time to do it.`,
      );
      await promptGroupLink(db, phone, waFrom, existing);
      return true;
    }
    // The admin asked a question about this fee ("For which?", "What is
    // this?", "Wt") instead of giving a number. Answer it — name the batch
    // — instead of trapping them in the same bare prompt.
    if (/\b(what|which|why|how|when|for)\b/i.test(trimmed) || /^batch\??$/i.test(trimmed)) {
      await sendWhatsAppText(
        waFrom,
        `This fee is for *${existing.batchName ?? "the batch"}*.\n\nReply with just the amount (e.g. *2200*), or *SKIP* to set it later.`,
      );
      return true;
    }
    const fee = Number(trimmed.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(fee) || fee <= 0) {
      await sendWhatsAppText(waFrom, `Please reply with just the fee amount for *${existing.batchName ?? "the batch"}* as a number (e.g. *2200*), or *SKIP* to set it later.`);
      return true;
    }
    const { data: currentBatch } = await db.from("batches").select("status, batch_limit, college").eq("id", existing.batchId).maybeSingle();
    let error: { message: string } | null = null;
    if (currentBatch?.status === "pending_setup") {
      try {
        const activated = await setBatchFeeAndActivate(db, existing.batchId, fee, currentBatch.batch_limit ?? null);
        if (!activated) error = { message: "Batch was already activated or changed." };
        else await processWaitlistForCollege(db, activated.college).catch((e) => console.error("[admin-batch-flow] waitlist processing failed:", e));
      } catch (e) {
        error = { message: e instanceof Error ? e.message : "activation failed" };
      }
    } else {
      const result = await db.from("batches").update({ fee_amount: fee }).eq("id", existing.batchId);
      error = result.error ? { message: result.error.message } : null;
    }
    if (error) {
      console.error("[admin-batch-flow] set_fee failed:", error.message);
      await sendWhatsAppText(waFrom, "❌ Could not save the fee. Please try again.");
      return true;
    }
    await sendWhatsAppText(
      waFrom,
      `✅ *${existing.batchName ?? "Batch"}* fee set to *₹${fee.toLocaleString("en-IN")}*.\n\nThe batch is active and accepting registrations/payments. Waiting students are being processed automatically.`,
    );
    await promptGroupLink(db, phone, waFrom, existing);
    return true;
  }

  if (!existing) {
    // SETFEE — price the current active batch without ending anything.
    if (upper === "SETFEE" || upper === "SET FEE") {
      const { data: actives } = await db.from("batches")
        .select("id, name, fee_amount").eq("status", "active").order("created_at", { ascending: false });
      const target = (actives ?? [])[0];
      if (!target) { await sendWhatsAppText(waFrom, "There is no active batch to set a fee for."); return true; }
      await setDraft(db, phone, { step: "set_fee", batchId: target.id, batchName: target.name });
      await sendWhatsAppText(waFrom, `💰 What's the registration fee for *${target.name}*?\n\nReply with just the amount (e.g. *2200*), or *SKIP*.`);
      return true;
    }
    if (upper !== "CREATE") return false;
    await setDraft(db, phone, { step: "college" });
    await promptCollege(db, waFrom);
    return true;
  }

  // Universal escape hatch, valid at any step.
  if (upper === "CANCEL") {
    if (existing.college) await releaseClaim(db, existing.college);
    await setDraft(db, phone, null);
    await sendWhatsAppText(waFrom, "Batch creation cancelled.");
    return true;
  }

  if (existing.step === "college") {
    const colleges = await getActiveColleges(db);
    const match = colleges.find(c => c.id.toUpperCase() === upper);
    if (!match) {
      await sendWhatsAppText(waFrom, `"${trimmed}" isn't a valid college ID. Please reply with one of the listed IDs, or CANCEL.`);
      return true;
    }
    const blockedBy = await tryClaimCollege(db, phone, match.id);
    if (blockedBy) {
      await setDraft(db, phone, null);
      await sendWhatsAppText(waFrom, `Another admin is already setting up a batch for *${match.name}*. Ask them to finish or CANCEL first.`);
      return true;
    }
    await setDraft(db, phone, { step: "fee", college: match.id, collegeName: match.name });
    await sendWhatsAppText(waFrom, `College: *${match.name}*.\n\nWhat's the registration fee (₹)? Reply with a number.`);
    return true;
  }

  if (existing.step === "fee") {
    if (upper === "STOP") {
      if (existing.college) await releaseClaim(db, existing.college);
      await setDraft(db, phone, null);
      await sendWhatsAppText(waFrom, "Batch creation cancelled.");
      return true;
    }
    if (/\b(what|which|why|how|when|for)\b/i.test(trimmed) || /^batch\??$/i.test(trimmed)) {
      await sendWhatsAppText(
        waFrom,
        `This fee is for the new batch at *${existing.collegeName ?? "the college"}*.\n\nReply with just the amount (e.g. 2200), or CANCEL.`,
      );
      return true;
    }
    const fee = Number(trimmed.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(fee) || fee <= 0) {
      await sendWhatsAppText(waFrom, `Please reply with a positive number for the fee for *${existing.collegeName ?? "the college"}* (e.g. 2200), or CANCEL.`);
      return true;
    }
    await setDraft(db, phone, { ...existing, step: "capacity", fee });
    await sendWhatsAppText(waFrom, `Fee: *₹${fee}*.\n\nWhat's the batch capacity? Reply a number, or *unlimited*.`);
    return true;
  }

  if (existing.step === "capacity") {
    let capacity: number | null;
    if (upper === "UNLIMITED") {
      capacity = null;
    } else {
      const n = Number(trimmed.replace(/[^\d]/g, ""));
      if (!Number.isFinite(n) || n <= 0) {
        await sendWhatsAppText(waFrom, "Please reply with a positive whole number, or *unlimited*, or CANCEL.");
        return true;
      }
      capacity = n;
    }
    const updated: BatchDraft = { ...existing, step: "confirm", capacity };
    await setDraft(db, phone, updated);
    await sendWhatsAppText(waFrom, summaryText(updated));
    return true;
  }

  if (existing.step === "confirm") {
    if (upper === "EDIT") {
      if (existing.college) await releaseClaim(db, existing.college);
      await setDraft(db, phone, { step: "college" });
      await promptCollege(db, waFrom);
      return true;
    }
    if (upper !== "YES") {
      await sendWhatsAppText(waFrom, "Please reply *YES*, *EDIT*, or *CANCEL*.");
      return true;
    }

    // YES — create it.
    if (!existing.college || !existing.fee) {
      if (existing.college) await releaseClaim(db, existing.college);
      await setDraft(db, phone, null);
      await sendWhatsAppText(waFrom, "Something went wrong with this batch draft — please start again with CREATE.");
      return true;
    }
    // YES — activate the pending_setup batch if one already exists
    // (the common case — students have been waiting, one was
    // auto-created), otherwise create a fresh one from scratch (admin
    // proactively running CREATE before anyone's actually waited yet).
    const { data: pending } = await db
      .from("batches")
      .select("id, name")
      .eq("college", existing.college)
      .eq("status", "pending_setup")
      .maybeSingle();

    let batch;
    let error: { message: string } | null = null;
    if (pending) {
      batch = await setBatchFeeAndActivate(db, pending.id, existing.fee, existing.capacity ?? null);
      if (!batch) error = { message: "That placeholder batch was already activated (possibly by another admin)." };
    } else {
      const name = await nextBatchName(db, existing.college);
      const created = await createBatch(db, {
        name,
        college: existing.college,
        fee_amount: existing.fee,
        batch_limit: existing.capacity ?? null,
      });
      batch = created.data;
      error = created.error;
    }
    await releaseClaim(db, existing.college);
    await setDraft(db, phone, null);

    if (error || !batch) {
      await sendWhatsAppText(waFrom, `❌ Failed to create the batch: ${error?.message ?? "unknown error"}`);
      return true;
    }

    let waitlistNote = "";
    if (batch.status === "active") {
      const result = await processWaitlistForCollege(db, existing.college);
      if (result.processed > 0 || result.failed > 0) {
        waitlistNote = `\n\nWaiting queue processed: ${result.processed} sent${result.failed ? `, ${result.failed} failed (left on the queue for retry)` : ""}.`;
      }
    } else {
      waitlistNote = `\n\nNote: another batch is already active for ${existing.collegeName}, so *${batch.name}* was created *paused* instead.`;
    }

    await sendWhatsAppText(
      waFrom,
      `✅ Batch *${batch.name}* created for *${existing.collegeName}* — ₹${existing.fee}, ${existing.capacity == null ? "unlimited" : existing.capacity} seats.${waitlistNote}`
    );
    return true;
  }

  return false;
}
