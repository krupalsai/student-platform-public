import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText, sendWhatsAppList, sendWhatsAppButtons } from "@/lib/whatsapp/client";
import { isWhatsAppBotEnabled } from "@/lib/services/payment-settings";
import { normaliseAdminPhone, invalidateAdminCache, type WaAdmin } from "@/lib/whatsapp/admin-service";

/**
 * Tappable admin menu for WhatsApp.
 *
 * Admins previously only got a plain text list of commands they had to type
 * exactly, while students got native tappable menus. This gives admins the same
 * interactive list, so the common actions are one tap instead of remembering
 * command syntax. Typed commands still work unchanged — this is additive.
 *
 * WhatsApp list limits: max 10 rows, title <= 24 chars, description <= 72.
 */

export const ADMIN_ROW_PREFIX = "adm_";

/**
 * Rows are built per-request: the bot on/off row is state-dependent, and it is
 * SUPER_ADMIN-only — silencing the bot for every student is a platform-wide
 * action, so it carries the same restriction as managing the admin roster.
 * Regular admins simply don't see the row (and the handlers reject it too).
 */
export function adminMenuRows(botEnabled: boolean, isSuperAdmin: boolean) {
  // One row, not two: WhatsApp lists cap at 10 rows and the rest of this menu
  // already fills them. Both switches live behind it.
  const botRow = isSuperAdmin
    ? [{ id: "adm_controls", title: botEnabled ? "⚙️ Bot Controls" : "🛑 Bot is STOPPED",
         description: botEnabled ? "Turn the bot on/off · old students" : "Tap here to start the bot again" }]
    : [];
  // Platform Status already surfaces the payments/students overview, so
  // Recent Payments/Recent Students were a second tap for the same numbers.
  // Missed Calls is dead weight until WhatsApp Calling is actually enabled
  // on the WABA (TODO #15) — zero calls have ever been logged, so the row
  // always opened to an empty result. All three still work as typed
  // commands (PAYMENTS / STUDENTS / CALLS) for anyone who wants them; only
  // the tappable row is gone, freeing headroom under WhatsApp's 10-row cap.
  const rows = [
    { id: "adm_status",    title: "📊 Platform Status",  description: "Students, payments, batches at a glance" },
    { id: "adm_pending",   title: "⏳ Pending Approvals", description: "Payments waiting for you to verify" },
    ...botRow,
    { id: "adm_admins",    title: "👤 Manage Admins",     description: "See who has access · add or remove an admin" },
    { id: "adm_end_batch", title: "🏁 End Batch",         description: "Close the active batch, open the next" },
    { id: "adm_broadcast", title: "📣 Send a Message",   description: "All students, or just one" },
    { id: "adm_answer",    title: "❓ Student Questions",  description: "See what students asked · answer and create an FAQ" },
  ];

  // Meta rejects a list with more than 10 rows outright — the admin would get
  // NO menu at all, not a truncated one. Adding an 11th row here has already
  // been done once by accident, so fail loudly rather than silently.
  if (rows.length > 10) {
    console.error(`[admin-menu] ${rows.length} rows exceeds WhatsApp's limit of 10 — the menu will not send. Fold one into a submenu.`);
  }
  return rows;
}

/** True when this WhatsApp number is an active SUPER_ADMIN. */
async function isSuperAdmin(db: SupabaseClient, waFrom: string): Promise<boolean> {
  const { getAdmin } = await import("@/lib/whatsapp/admin-service");
  const admin = await getAdmin(db, waFrom);
  return admin?.role === "SUPER_ADMIN";
}

/** Sends the tappable admin menu, tailored to the caller's role. */
export async function sendAdminMenu(db: SupabaseClient, waFrom: string): Promise<void> {
  const [botEnabled, superAdmin] = await Promise.all([
    isWhatsAppBotEnabled(db),
    isSuperAdmin(db, waFrom),
  ]);
  // Only a SUPER_ADMIN is told the bot is stopped — for everyone else that row
  // isn't actionable, so the banner would just be noise they can't resolve.
  await sendWhatsAppList(
    waFrom,
    !botEnabled && superAdmin
      ? "🛠 *Admin Menu*\n\n🛑 *The bot is currently STOPPED* — students get no replies.\n\nPick an action below — or just type a command."
      : "🛠 *Admin Menu*\n\nPick an action below — or just type a command.",
    "Admin Actions",
    adminMenuRows(botEnabled, superAdmin),
  );
}

/** Flips the kill switch. Returns the new state. */
export async function setBotEnabled(db: SupabaseClient, enabled: boolean): Promise<void> {
  await db.from("app_settings").upsert(
    { key: "whatsapp_bot_enabled", value: String(enabled) },
    { onConflict: "key" },
  );
}

/**
 * Adds another number as an admin. Returns a human-readable result message.
 * Only a SUPER_ADMIN may grant access — otherwise any admin could escalate the
 * roster without oversight.
 */
export async function addAdmin(
  db: SupabaseClient,
  actor: WaAdmin,
  rawPhone: string,
): Promise<string> {
  if (actor.role !== "SUPER_ADMIN") {
    return "❌ Only a SUPER_ADMIN can add new admins.";
  }
  const phone = normaliseAdminPhone(rawPhone);
  if (phone.length !== 10) {
    return "❌ That doesn't look like a valid 10-digit mobile number.\n\nExample: *ADD ADMIN 9876543210*";
  }

  const { data: existing } = await db
    .from("admins").select("id, active").eq("phone", phone).maybeSingle();

  if (existing) {
    if (existing.active) return `ℹ️ +91${phone} is already an admin.`;
    await db.from("admins").update({ active: true }).eq("id", existing.id);
    invalidateAdminCache(phone);
    return `✅ +91${phone} has been re-activated as an admin.` + (await welcomeNewAdmin(db, phone));
  }

  const { error } = await db.from("admins").insert({
    phone, role: "ADMIN", active: true, created_by: actor.id,
  });
  if (error) {
    console.error("[admin-menu] addAdmin failed:", error.message);
    return "❌ Could not add that admin. Please try again.";
  }
  invalidateAdminCache(phone);
  return `✅ +91${phone} is now an admin.` + (await welcomeNewAdmin(db, phone));
}

/**
 * Tells the new admin themselves, and opens the admin menu for them — being
 * granted access is useless if nobody tells you it happened, and the old
 * message only ever went back to the person doing the granting.
 *
 * Returns a suffix for that person's confirmation, because this send can
 * legitimately fail: Meta only allows a free-form message inside 24 hours of
 * the recipient's last message, so someone who has never written to this
 * number cannot be reached until they do. Saying "they've been told" when
 * they haven't is the one outcome worth avoiding, so the failure is reported.
 */
async function welcomeNewAdmin(db: SupabaseClient, phone: string): Promise<string> {
  try {
    const ok = await sendWhatsAppText(
      phone,
      "🛠 *You are now an admin.*\n\n" +
      "You can manage the platform right here on WhatsApp — check payments, approve students, " +
      "look up records and message students.\n\n" +
      "Tap *Admin Actions* below to see everything you can do. You can bring this menu back any " +
      "time by sending *MENU*.",
    );
    if (!ok) {
      return "\n\n⚠️ I couldn't message them — WhatsApp only allows that within 24 hours of *their* last message." +
             "\n\nAsk them to send *Hi* to this number; the admin menu opens straight away.";
    }
    // Menu second, so the welcome text is what they read first.
    await sendAdminMenu(db, phone);
    return "\n\nThey've been told, and the admin menu is already open on their phone.";
  } catch (e) {
    console.error("[admin-menu] welcomeNewAdmin failed:", e);
    return "\n\n⚠️ They were added, but I couldn't message them. Ask them to send *Hi* to this number.";
  }
}

/**
 * Removes an admin's access. Deactivates rather than deletes, so the record of
 * who had access (and who granted it) survives for audit.
 *
 * Guards, in order — each prevents a way to lock everyone out:
 *   - only a SUPER_ADMIN may revoke access
 *   - you cannot remove yourself (the classic self-lockout)
 *   - you cannot remove the last remaining SUPER_ADMIN
 */
export async function removeAdmin(
  db: SupabaseClient,
  actor: WaAdmin,
  rawPhone: string,
): Promise<string> {
  if (actor.role !== "SUPER_ADMIN") {
    return "❌ Only a SUPER_ADMIN can remove admins.";
  }
  const phone = normaliseAdminPhone(rawPhone);
  if (phone.length !== 10) {
    return "❌ That doesn't look like a valid 10-digit mobile number.\n\nExample: *REMOVE ADMIN 9876543210*";
  }
  if (phone === normaliseAdminPhone(actor.phone)) {
    return "❌ You can't remove yourself — that would lock you out.\n\nAsk another SUPER_ADMIN to do it.";
  }

  const { data: target } = await db
    .from("admins").select("id, role, active").eq("phone", phone).maybeSingle();

  if (!target || !target.active) return `ℹ️ +91${phone} is not currently an admin.`;

  if (target.role === "SUPER_ADMIN") {
    const { count } = await db
      .from("admins").select("id", { count: "exact", head: true })
      .eq("role", "SUPER_ADMIN").eq("active", true);
    if ((count ?? 0) <= 1) {
      return "❌ That's the last SUPER_ADMIN — removing them would leave nobody able to manage admins.";
    }
  }

  const { error } = await db.from("admins").update({ active: false }).eq("id", target.id);
  if (error) {
    console.error("[admin-menu] removeAdmin failed:", error.message);
    return "❌ Could not remove that admin. Please try again.";
  }
  invalidateAdminCache(phone);
  return `✅ +91${phone} no longer has admin access.`;
}

/** Human-readable list of who currently has admin access. */
export async function listAdminsMessage(db: SupabaseClient): Promise<string> {
  const { data } = await db
    .from("admins")
    .select("phone, role")
    .eq("active", true)
    .order("role", { ascending: true });

  const rows = data ?? [];
  const lines = rows.length
    ? rows.map((a: { phone: string; role: string }) =>
        `• +91${a.phone}${a.role === "SUPER_ADMIN" ? "  (super admin)" : ""}`).join("\n")
    : "_No admins found._";

  return (
    `👤 *Admins with access*\n\n${lines}\n\n` +
    `*To add:*\n*ADD ADMIN 9876543210*\n\n` +
    `*To remove:*\n*REMOVE ADMIN 9876543210*\n\n` +
    `_Only a super admin can add or remove. You can't remove yourself._`
  );
}

/**
 * Manage Admins, as taps rather than typed commands.
 *
 * Tapping the menu row used to reply with a wall of text telling the admin to
 * type "ADD ADMIN 9876543210" — the exact command syntax the tappable menu
 * exists to get rid of. Now the roster comes with buttons: Add walks into a
 * one-question prompt, Remove lists the current admins so the target is picked
 * by tapping it, never retyped.
 *
 * A phone number genuinely cannot be tapped — WhatsApp interactive messages
 * carry no free-text input — so Add is the one place a reply is still typed,
 * and it's a bare number rather than a command.
 */
export async function sendAdminRoster(db: SupabaseClient, waFrom: string): Promise<void> {
  const [{ data }, superAdmin] = await Promise.all([
    db.from("admins").select("phone, role").eq("active", true).order("role", { ascending: true }),
    isSuperAdmin(db, waFrom),
  ]);

  const rows = (data ?? []) as { phone: string; role: string }[];
  const lines = rows.length
    ? rows.map((a) => `• +91${a.phone}${a.role === "SUPER_ADMIN" ? "  (super admin)" : ""}`).join("\n")
    : "_No admins found._";
  const body = `👤 *Admins with access*\n\n${lines}`;

  // A regular admin has no add/remove rights, so buttons would only be a dead
  // end — they get the roster and the reason they can't change it.
  if (!superAdmin) {
    await sendWhatsAppText(waFrom, `${body}\n\n_Only a super admin can add or remove admins._`);
    return;
  }

  const sent = await sendWhatsAppButtons(waFrom, body, [
    { id: "adm_admin_add", title: "➕ Add admin" },
    { id: "adm_admin_rm",  title: "➖ Remove admin" },
  ]);
  // Buttons can fail (Meta outage, unsupported client) — the typed commands
  // still work, so fall back to them rather than leaving a dead end.
  if (!sent) await sendWhatsAppText(waFrom, await listAdminsMessage(db));
}

/** Step 2 of Remove — the roster as tappable rows, minus anyone unremovable. */
export async function promptRemoveAdmin(db: SupabaseClient, waFrom: string): Promise<void> {
  if (!(await isSuperAdmin(db, waFrom))) {
    await sendWhatsAppText(waFrom, "❌ Only a SUPER_ADMIN can remove admins.");
    return;
  }
  const { data } = await db
    .from("admins").select("phone, role").eq("active", true).order("role", { ascending: true });

  const all = (data ?? []) as { phone: string; role: string }[];
  const superCount = all.filter((a) => a.role === "SUPER_ADMIN").length;
  const me = normaliseAdminPhone(waFrom);

  // Only offer rows that removeAdmin() would actually accept: not yourself,
  // and not the last super admin. Showing a row that always errors is worse
  // than not showing it.
  const removable = all.filter((a) => {
    if (normaliseAdminPhone(a.phone) === me) return false;
    if (a.role === "SUPER_ADMIN" && superCount <= 1) return false;
    return true;
  });

  if (!removable.length) {
    await sendWhatsAppText(
      waFrom,
      "There's nobody you can remove right now.\n\n_You can't remove yourself, and the last super admin can't be removed._",
    );
    return;
  }

  await sendWhatsAppList(
    waFrom,
    "➖ *Remove an admin*\n\nTap the person whose access you want to remove.",
    "Choose admin",
    removable.slice(0, 10).map((a) => ({
      id: `adm_admrm_${normaliseAdminPhone(a.phone)}`,
      title: `+91${a.phone}`.slice(0, 24),
      description: (a.role === "SUPER_ADMIN" ? "Super admin" : "Admin") + " — tap to remove",
    })),
  );
}

/**
 * The "send me the number to add" prompt is the one admin step that needs a
 * typed reply, so it parks a state on whatsapp_moderation.admin_batch_draft —
 * the same JSONB the batch wizard uses — and consumes the very next message.
 * handleAdminPhoneCapture() must run BEFORE the batch flow and before command
 * matching, or a bare 10-digit number would be read as something else.
 */
const ADD_ADMIN_STEP = "add_admin_phone";

export async function promptAddAdmin(db: SupabaseClient, waFrom: string): Promise<void> {
  if (!(await isSuperAdmin(db, waFrom))) {
    await sendWhatsAppText(waFrom, "❌ Only a SUPER_ADMIN can add new admins.");
    return;
  }
  const { normalizePhone } = await import("@/lib/services/students");
  const phone = normalizePhone(waFrom);

  // That column is shared with the batch wizard. Overwriting a half-finished
  // batch draft would throw away answers the admin already gave, silently.
  const { data } = await db
    .from("whatsapp_moderation").select("admin_batch_draft").eq("phone", phone).maybeSingle();
  const draft = data?.admin_batch_draft as { step?: string } | null | undefined;
  if (draft?.step && draft.step !== ADD_ADMIN_STEP) {
    await sendWhatsAppText(
      waFrom,
      "You're in the middle of another step right now. Reply *CANCEL* to finish it first, then tap ➕ Add admin again.",
    );
    return;
  }

  await db.from("whatsapp_moderation").upsert(
    { phone, admin_batch_draft: { step: ADD_ADMIN_STEP } },
    { onConflict: "phone" },
  );
  await sendWhatsAppText(
    waFrom,
    "➕ *Add an admin*\n\nSend the *10-digit mobile number* of the person you want to make an admin.\n\n" +
    "Example: *9876543210*\n\n_Reply *CANCEL* to stop._",
  );
}

/**
 * Consumes the reply to the Add-admin prompt. Returns true when this message
 * was the awaited phone number (or a cancel), so the caller stops here.
 */
export async function handleAdminPhoneCapture(
  db: SupabaseClient,
  waFrom: string,
  text: string,
): Promise<boolean> {
  const { normalizePhone } = await import("@/lib/services/students");
  const phone = normalizePhone(waFrom);

  const { data } = await db
    .from("whatsapp_moderation").select("admin_batch_draft").eq("phone", phone).maybeSingle();
  const draft = data?.admin_batch_draft as { step?: string } | null | undefined;
  if (draft?.step !== ADD_ADMIN_STEP) return false;

  const clear = () =>
    db.from("whatsapp_moderation").upsert(
      { phone, admin_batch_draft: null }, { onConflict: "phone" },
    );

  const trimmed = text.trim();
  if (/^(CANCEL|STOP|BACK)$/i.test(trimmed)) {
    await clear();
    await sendWhatsAppText(waFrom, "Cancelled — no admin was added.");
    return true;
  }

  const { getAdmin } = await import("@/lib/whatsapp/admin-service");
  const actor = await getAdmin(db, waFrom);
  if (!actor) {
    await clear();
    await sendWhatsAppText(waFrom, "❌ Could not verify your admin account.");
    return true;
  }

  const candidate = normaliseAdminPhone(trimmed);
  if (candidate.length !== 10) {
    // Stay in the prompt rather than dropping them back to square one.
    await sendWhatsAppText(
      waFrom,
      "That doesn't look like a 10-digit mobile number.\n\nSend just the number (e.g. *9876543210*), or reply *CANCEL*.",
    );
    return true;
  }

  await clear();
  await sendWhatsAppText(waFrom, await addAdmin(db, actor, candidate));
  return true;
}

/** Step 1 of End Batch — pick which college's batch to end. */
async function promptEndBatchCollege(db: SupabaseClient, waFrom: string): Promise<void> {
  const { data: actives } = await db
    .from("batches").select("id, name, college").eq("status", "active");

  if (!actives?.length) {
    await sendWhatsAppText(waFrom, "There are no active batches to end.");
    return;
  }
  // One active batch — no point asking which college.
  if (actives.length === 1) {
    await showBatchBeforeEnding(db, waFrom, actives[0].id);
    return;
  }
  // Title is the batch NAME, not just the college: "GNIT" gave no way to tell
  // which batch you were about to close, and the number is the thing an admin
  // is checking for. Student counts go in the description as a second check.
  const rows = await Promise.all(
    actives.slice(0, 10).map(async (b: { id: string; name: string; college: string }) => {
      // is_profile_complete=true — same fix as showBatchBeforeEnding below,
      // which already had it; this list view didn't, so it showed inflated
      // counts (abandoned registration attempts) an admin would end up
      // ending a batch based on.
      const { count } = await db
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("batch_id", b.id).eq("is_profile_complete", true); // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
      return {
        id: `adm_eb_${b.id}`,
        title: String(b.name).slice(0, 24),
        description: `${b.college} · ${count ?? 0} students — tap to see details`.slice(0, 72),
      };
    }),
  );
  await sendWhatsAppList(waFrom, "🏁 *End Batch*\n\nWhich batch do you want to end?", "Choose batch", rows);
}

/**
 * Step 2 — show the batch's details and its export downloads BEFORE ending it,
 * then ask for confirmation. Deliberately in this order: the admin gets the
 * final roster (DOCX + every student's College ID) in hand first, so ending the
 * batch is never the thing that loses them the data.
 */
async function showBatchBeforeEnding(db: SupabaseClient, waFrom: string, batchId: string): Promise<void> {
  const { data: batch } = await db
    .from("batches").select("id, name, college, status, fee_amount").eq("id", batchId).maybeSingle();
  if (!batch) { await sendWhatsAppText(waFrom, "That batch no longer exists."); return; }

  // Roster + payment counts for this batch.
  const { data: students } = await db
    .from("profiles").select("id").eq("batch_id", batchId).eq("is_profile_complete", true); // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
  const ids = (students ?? []).map((s: { id: string }) => s.id);

  // Paid = an approved payment exists (an approved one is never shadowed by a
  // later failed attempt), and "to move" is computed by the exact function the
  // close itself uses — so the number promised here is the number moved.
  const { getPaidStudentIds, findUnpaidMembers } = await import("@/lib/services/batches");
  const paid = ids.length ? (await getPaidStudentIds(db, ids)).size : 0;
  let toMove: number | null = null;
  try { toMove = (await findUnpaidMembers(db, batchId)).length; } catch (e) { console.error("[admin-menu] unpaid count failed:", e); }

  // Short-lived, batch-scoped download links (a WhatsApp admin has no session).
  const { issueExportToken, EXPORT_TOKEN_TTL_MINUTES } = await import("@/lib/export-token");
  const token = await issueExportToken(db, batchId, waFrom);
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(/\/$/, "");

  const links = token
    ? `📄 *Student list (Word)*\n${base}/api/admin/export/docx/${batchId}?xt=${token}\n\n` +
      `🗂 *Word + all College ID photos (ZIP)*\n${base}/api/admin/export/docx/${batchId}/zip?xt=${token}\n\n` +
      `_Links work for ${EXPORT_TOKEN_TTL_MINUTES} minutes._\n\n`
    : `_Download links could not be generated — use the admin dashboard._\n\n`;

  await sendWhatsAppText(
    waFrom,
    `🏁 *${batch.name}* (${batch.college})\n\n` +
    `👥 Registered: *${ids.length}*\n` +
    `✅ Paid: *${paid}*\n` +
    (toMove == null ? "" : `➡️ Will move to the next batch: *${toMove}* (everyone without an approved payment, including unfinished registrations)\n`) +
    `💰 Fee: ${batch.fee_amount ? `₹${Number(batch.fee_amount).toLocaleString("en-IN")}` : "_not set_"}\n\n` +
    links +
    `Download these first — then confirm below to close this batch and open the next one.`,
  );

  await sendWhatsAppButtons(
    waFrom,
    `End *${batch.name}* now?\n\nStudents who have not paid move to the next batch automatically; paid students stay here. The fee and payment settings carry over.`,
    [{ id: `adm_ebgo_${batchId}`, title: "🏁 End batch" }, { id: "adm_eb_cancel", title: "Cancel" }],
  );
}

/**
 * Handles a tap on the admin menu (or its confirmation buttons).
 * Returns true when the selection was handled here.
 *
 * Rows that need an argument (broadcast text, a phone number) reply with the
 * exact command to type, since WhatsApp lists can't collect free text — the tap
 * becomes a prompt rather than a dead end.
 */
export async function handleAdminSelection(
  db: SupabaseClient,
  waFrom: string,
  selectionId: string,
  runCommand: (cmd: string) => Promise<boolean>,
): Promise<boolean> {
  // Prefixed ids carry a batch id, so they're matched before the exact switch.
  {
    // Paid-count college/batch taps. Lives in its own module: router.ts
    // already imports this file, so putting the choosers in either would make
    // the two import each other.
    const { handlePaidCountSelection } = await import("@/lib/whatsapp/paid-count");
    if (await handlePaidCountSelection(db, waFrom, selectionId)) return true;
  }
  if (selectionId.startsWith("adm_ebgo_")) {
    const batchId = selectionId.slice("adm_ebgo_".length);
    const { endBatchAndCreateNext, describeEndBatchFailure, endBatchSummaryLines } = await import("@/lib/services/batches");
    const { data: batch } = await db.from("batches").select("name").eq("id", batchId).maybeSingle();
    const result = await endBatchAndCreateNext(db, batchId, null);
    if (!result.ok) {
      const { message, batchClosed } = describeEndBatchFailure(result.reason);
      await sendWhatsAppText(
        waFrom,
        batchClosed ? `⚠️ *${batch?.name ?? "That batch"}* — ${message}` : `❌ Could not end *${batch?.name ?? "that batch"}* — ${message}`,
      );
      return true;
    }
    await sendWhatsAppText(waFrom, `🏁 ${endBatchSummaryLines(result, (s) => `*${s}*`).join("\n\n")}`);

    // Ask about the fee right here instead of sending the admin to the website.
    // The fee carries over from the closed batch, so usually this is a
    // confirm-or-change; only when the closed batch had none is the new one
    // unpriced and payments blocked until this is answered — leaving that to a
    // link is how a batch silently stays dead. The reply is consumed by the
    // "set_fee" step in admin-batch-flow (which then asks for the group link).
    const { normalizePhone } = await import("@/lib/services/students");
    await db.from("whatsapp_moderation").upsert(
      {
        phone: normalizePhone(waFrom),
        admin_batch_draft: { step: "set_fee", batchId: result.newBatch.id, batchName: result.newBatch.name },
      },
      { onConflict: "phone" },
    );
    await sendWhatsAppText(
      waFrom,
      result.newBatch.fee_amount
        ? `💰 *${result.newBatch.name}* uses the same fee as the last batch: *₹${result.newBatch.fee_amount.toLocaleString("en-IN")}*.\n\n` +
          `Reply with a new amount to change it, or *SKIP* to keep it.`
        : `💰 *What's the registration fee for ${result.newBatch.name}?*\n\n` +
          `Reply with just the amount (e.g. *2200*).\n\n` +
          `_Until a fee is set, students can register but cannot pay._ Reply *SKIP* to set it later.`,
    );
    return true;
  }
  if (selectionId.startsWith("adm_eb_") && selectionId !== "adm_eb_cancel") {
    await showBatchBeforeEnding(db, waFrom, selectionId.slice("adm_eb_".length));
    return true;
  }

  // ── Remove-admin: pick a person, then confirm ────────────────────────────
  // The phone travels in the id, so the admin never retypes it. Both steps
  // re-check SUPER_ADMIN: the rows are only *shown* to a super admin, but an
  // id can be replayed by anyone, and removeAdmin() is the real gate.
  if (selectionId.startsWith("adm_admrmgo_")) {
    const target = selectionId.slice("adm_admrmgo_".length);
    const { getAdmin } = await import("@/lib/whatsapp/admin-service");
    const actor = await getAdmin(db, waFrom);
    if (!actor) { await sendWhatsAppText(waFrom, "❌ Could not verify your admin account."); return true; }
    await sendWhatsAppText(waFrom, await removeAdmin(db, actor, target));
    return true;
  }
  if (selectionId.startsWith("adm_admrm_")) {
    const target = selectionId.slice("adm_admrm_".length);
    if (!(await isSuperAdmin(db, waFrom))) {
      await sendWhatsAppText(waFrom, "❌ Only a SUPER_ADMIN can remove admins.");
      return true;
    }
    await sendWhatsAppButtons(
      waFrom,
      `➖ *Remove +91${target}?*\n\nThey lose admin access immediately. You can add them back any time.`,
      [{ id: `adm_admrmgo_${target}`, title: "🗑 Remove" }, { id: "adm_admin_cancel", title: "Cancel" }],
    );
    return true;
  }

  switch (selectionId) {
    // Direct read-only actions — reuse the existing text command handlers.
    case "adm_status":   return runCommand("STATUS");
    case "adm_pending":  return runCommand("PENDING");
    case "adm_payments": return runCommand("PAYMENTS");
    case "adm_students": return runCommand("STUDENTS");

    // ── Bot Controls submenu: both platform-wide switches ───────────────
    case "adm_controls": {
      if (!(await isSuperAdmin(db, waFrom))) {
        await sendWhatsAppText(waFrom, "❌ Only a SUPER_ADMIN can change the bot controls.");
        return true;
      }
      const { isClosedBatchBlockEnabled, closedBatchSummary } = await import("@/lib/closed-batch-gate");
      const [running, blocking, closed] = await Promise.all([
        isWhatsAppBotEnabled(db),
        isClosedBatchBlockEnabled(db),
        closedBatchSummary(db),
      ]);
      // Name the batches. "Old students" gives no way to tell whether you are
      // about to switch off GNIT Batch 1 or something you didn't mean to.
      const who = closed.students
        ? `${closed.label} · ${closed.students} students`
        : closed.label;
      // BOTH states are always listed, never just the opposite action. Showing
      // only "Stop the Bot" while it runs left no visible way to start it, so
      // the one thing an admin needs in a hurry looked missing. Each row says
      // what it does and which one is currently on.
      const now = " · ON NOW";
      await sendWhatsAppList(
        waFrom,
        `⚙️ *Bot Controls*\n\n` +
        `Bot: ${running ? "🟢 *Running*" : "🛑 *Stopped*"}\n` +
        `Old students: ${blocking ? "🚫 *Blocked*" : "✅ *Allowed*"}\n` +
        `_Old students = ${who}_\n\n` +
        `Tap the setting you want. It applies straight away.`,
        "Change a setting",
        [
          { id: "adm_bot_on",
            title: "🟢 Bot ON",
            description: (running ? "Replying to students" + now : "Start replying to students again").slice(0, 72) },
          { id: "adm_bot_off",
            title: "🛑 Bot OFF",
            description: (running ? "Stop replying to students completely" : "Not replying to anyone" + now).slice(0, 72) },
          { id: "adm_oldstu_off",
            title: "✅ Old students ON",
            description: (`${closed.label} can use the bot` + (blocking ? "" : now)).slice(0, 72) },
          { id: "adm_oldstu_on",
            title: "🚫 Old students OFF",
            description: (`${closed.label}: one notice, then silence` + (blocking ? now : "")).slice(0, 72) },
          { id: "adm_bot_cancel", title: "⬅️ Back", description: "Leave both settings as they are" },
        ],
      );
      return true;
    }

    // ── Old-student block: SUPER_ADMIN only, confirm before changing ────
    case "adm_oldstu":
    case "adm_oldstu_on":
    case "adm_oldstu_off": {
      if (!(await isSuperAdmin(db, waFrom))) {
        await sendWhatsAppText(waFrom, "❌ Only a SUPER_ADMIN can change this.");
        return true;
      }
      const { isClosedBatchBlockEnabled, setClosedBatchBlockEnabled } = await import("@/lib/closed-batch-gate");
      if (selectionId === "adm_oldstu_on") {
        if (await isClosedBatchBlockEnabled(db)) {
          await sendWhatsAppText(waFrom, "🚫 Old students are *already blocked* — nothing changed.");
          return true;
        }
        await setClosedBatchBlockEnabled(db, true);
        await sendWhatsAppText(waFrom, "🚫 *Old students blocked.*\n\nStudents in a closed batch get one message explaining it, then the bot ignores them. Their dashboard and Route Map still work.\n\nTo undo: *Bot Controls* → *✅ Old students ON*.");
        return true;
      }
      if (selectionId === "adm_oldstu_off") {
        if (!(await isClosedBatchBlockEnabled(db))) {
          await sendWhatsAppText(waFrom, "✅ Old students are *already allowed* — nothing changed.");
          return true;
        }
        await setClosedBatchBlockEnabled(db, false);
        await sendWhatsAppText(waFrom, "✅ *Old students allowed.*\n\nStudents in closed batches can use the bot normally again.");
        return true;
      }
      return handleAdminSelection(db, waFrom, "adm_controls", runCommand);
    }

    // ── Kill switch: SUPER_ADMIN only, confirm before changing state ────
    // Enforced here as well as hidden from the menu — a row being absent is
    // presentation, not access control, and these ids can still be replayed.
    case "adm_bot":
    case "adm_bot_off":
    case "adm_bot_on": {
      if (!(await isSuperAdmin(db, waFrom))) {
        await sendWhatsAppText(waFrom, "❌ Only a SUPER_ADMIN can stop or start the bot.");
        return true;
      }
      // Both rows are now always shown, so tapping the one already in effect is
      // normal rather than a mistake — say so instead of pretending a change.
      if (selectionId === "adm_bot_off") {
        if (!(await isWhatsAppBotEnabled(db))) {
          await sendWhatsAppText(waFrom, "🛑 The bot is *already stopped* — nothing changed.");
          return true;
        }
        await setBotEnabled(db, false);
        await sendWhatsAppText(waFrom, "🛑 *Bot stopped.*\n\nStudents now get no replies at all — they are not told why.\n\nTo start it again: *Bot Controls* → *🟢 Bot ON*, or just type *BOT ON*.");
        return true;
      }
      if (selectionId === "adm_bot_on") {
        if (await isWhatsAppBotEnabled(db)) {
          await sendWhatsAppText(waFrom, "🟢 The bot is *already running* — nothing changed.");
          return true;
        }
        await setBotEnabled(db, true);
        await sendWhatsAppText(waFrom, "🟢 *Bot started.* It is replying to students again.");
        return true;
      }
      // Bare "adm_bot" only reaches here from a menu cached before Bot Controls
      // existed. Send them to the same screen everyone else sees rather than
      // maintaining a second, older-looking flow.
      return handleAdminSelection(db, waFrom, "adm_controls", runCommand);
    }
    case "adm_bot_cancel": {
      await sendWhatsAppText(waFrom, "Cancelled — nothing changed.");
      return true;
    }

    // ── Rows that need an argument: prompt with the exact syntax ────────
    case "adm_admins":
      await sendAdminRoster(db, waFrom);
      return true;
    // Both prompts enforce SUPER_ADMIN themselves — the buttons are only shown
    // to a super admin, but an id can be replayed by anyone.
    case "adm_admin_add":
      await promptAddAdmin(db, waFrom);
      return true;
    case "adm_admin_rm":
      await promptRemoveAdmin(db, waFrom);
      return true;
    case "adm_admin_cancel":
      await sendWhatsAppText(waFrom, "Cancelled — the admin list is unchanged.");
      return true;
    case "adm_end_batch":
      await promptEndBatchCollege(db, waFrom);
      return true;
    case "adm_eb_cancel":
      await sendWhatsAppText(waFrom, "Cancelled — the batch is unchanged.");
      return true;
    // Two channels reach two different groups: Telegram reaches students who
    // started the bot, WhatsApp reaches everyone who ever messaged it. Showing
    // the live counts means the choice is made on facts, not a guess.
    case "adm_broadcast": {
      const [{ count: tg }, { count: wa }] = await Promise.all([
        db.from("profiles").select("id", { count: "exact", head: true })
          .eq("bot_started", true).not("telegram_id", "is", null),
        db.from("whatsapp_moderation").select("phone", { count: "exact", head: true }),
      ]);
      await sendWhatsAppList(
        waFrom,
        "📣 *Broadcast*\n\nWho should get this message?",
        "Choose channel",
        [
          { id: "adm_bc_tg", title: "✈️ Telegram",  description: `${tg ?? 0} students who started the bot` },
          { id: "adm_bc_wa", title: "💬 WhatsApp",  description: `${wa ?? 0} people who messaged this bot` },
          { id: "adm_message", title: "✉️ One student", description: "Send a WhatsApp message to a single number" },
          { id: "adm_bot_cancel", title: "⬅️ Back", description: "Send nothing" },
        ],
      );
      return true;
    }
    case "adm_bc_tg":
      await sendWhatsAppText(waFrom, "✈️ *Telegram broadcast*\n\nReply with:\n*BROADCAST <your message>*\n\nExample:\n*BROADCAST Certificates will be issued next Monday.*");
      return true;
    case "adm_bc_wa": {
      // Say up front how many are actually reachable. WhatsApp only allows a
      // free message within 24h of THEIR last message; everyone else can't be
      // reached — broadcasts are free-only, no paid template is in use.
      const { data: rows } = await db
        .from("whatsapp_moderation").select("last_message_at");
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const inWindow = (rows ?? []).filter(
        (r: { last_message_at: string | null }) =>
          r.last_message_at && new Date(r.last_message_at).getTime() > cutoff,
      ).length;
      const total = (rows ?? []).length;

      await sendWhatsAppText(
        waFrom,
        "💬 *WhatsApp broadcast*\n\nReply with:\n*WHATSAPP BROADCAST <your message>*\n\n" +
        `Reachable right now: *${inWindow}* of *${total}*.\n` +
        "⚠️ The other " + (total - inWindow) + " last messaged over 24 hours ago. WhatsApp won't deliver a free message to them — broadcasts are free-only, no paid template is in use.",
      );
      return true;
    }
    case "adm_calls": {
      const { recentMissedCalls } = await import("@/lib/whatsapp/calls");
      await sendWhatsAppText(waFrom, await recentMissedCalls(db));
      return true;
    }
    case "adm_message":
      await sendWhatsAppText(
        waFrom,
        "✉️ *Message one student*\n\nReply with:\n*MESSAGE <number> <your message>*\n\n" +
        "Example:\n*MESSAGE 9876543210 Your payment has been received.*\n\n" +
        "📷 *To send a photo:* attach it and put that same line in the caption.",
      );
      return true;
    // Show the questions themselves. This row used to print only a usage line
    // with an invented example id, so an admin tapping it learned nothing about
    // what students had actually asked.
    case "adm_answer": {
      const { buildOpenQuestionsMessage } = await import("@/lib/whatsapp/open-questions");
      await sendWhatsAppText(waFrom, await buildOpenQuestionsMessage(db));
      return true;
    }

    default:
      return false;
  }
}

