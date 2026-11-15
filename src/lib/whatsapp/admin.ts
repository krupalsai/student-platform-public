import { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppCtaButton } from "@/lib/whatsapp/client";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";
import { normalizePhone } from "@/lib/services/students";
import { answerUnknownQuestion, ignoreUnknownQuestion } from "@/lib/services/faq";
import { getAdmin, normaliseAdminPhone, bootstrapAdmins } from "@/lib/whatsapp/admin-service";
import { handleAdminBatchFlow } from "@/lib/whatsapp/admin-batch-flow";
import { endBatchAndCreateNext, describeEndBatchFailure, endBatchSummaryLines } from "@/lib/services/batches";
import { deliverAnswerToAppThreads } from "@/lib/services/support-cases";

/**
 * Admin WhatsApp Command Handler
 *
 * Phase 1: isAdminSender() is now a thin compatibility shim.
 * Real admin detection uses getAdmin() which queries the admins table.
 * The router uses getAdmin() directly; isAdminSender() kept for any
 * remaining call sites during migration.
 *
 * Supported commands (unchanged):
 *   ANSWER UQ-104\n<answer>
 *   ANSWER UQ-XXX <answer>
 *   HELP
 */

export async function getActiveAdminPhones(db: SupabaseClient): Promise<string[]> {
  try {
    const { data, error } = await db
      .from("admins")
      .select("phone")
      .ilike("role", "SUPER_ADMIN")
      .eq("active", true);
    if (error) throw error;
    const phones = [...new Set(
      (data ?? [])
        .map((r: any) => normaliseAdminPhone(r.phone))
        .filter(Boolean),
    )];
    if (!phones.length) {
      console.error("[AdminService] getActiveAdminPhones returned zero recipients — no active SUPER_ADMIN row found");
    }
    return phones;
  } catch (err) {
    console.error("[AdminService] getActiveAdminPhones failed:", (err as Error).message);
    return [];
  }
}

export function isAdminSender(phone: string | null | undefined): boolean {
  const env = (process.env.WHATSAPP_ADMIN_NUMBER ?? "").replace(/\D/g, "").slice(-10);
  if (!env || env.length !== 10) return false;
  const from = String(phone ?? "").replace(/\D/g, "").slice(-10);
  return from.length === 10 && from === env;
}

export async function notifyAdminWhatsApp(
  db: SupabaseClient,
  uqId: string,
  shortId: number | null,
  question: string,
  phone: string,
  occurrences: number
): Promise<void> {
  const phones = await getActiveAdminPhones(db);
  if (!phones.length) return;
  const displayId = shortId != null ? `UQ-${String(shortId).padStart(3, "0")}` : uqId.slice(0, 8);

  const { data: mod } = await db.from("whatsapp_moderation")
    .select("preferred_name").eq("phone", normalizePhone(phone)).maybeSingle();
  const name = mod?.preferred_name ?? null;
  const timeIst = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

  const text =
    `🆕 *New Student Question*\n\n` +
    `*ID:* ${displayId}\n` +
    (name ? `*Student:* ${name}\n` : ``) +
    `*Phone:* +${phone}\n` +
    `*Question:* ${question}\n` +
    `*Time:* ${timeIst} IST\n` +
    `*Occurrences:* ${occurrences}\n\n` +
    `Reply exactly:\n\`ANSWER ${displayId}\n<your answer>\``;
  await Promise.all(phones.map(p => sendWhatsAppText(normalizeWhatsAppNumber(p), text)));
}

/** Notify SUPER_ADMIN only after the student has actually returned to WhatsApp via Continue. */
export async function notifySuperAdminOfRegistrationStart(
  db: SupabaseClient,
  collegeName: string,
  phone: string,
  batchName: string | null,
  fee: number | null,
): Promise<void> {
  const phones = await getActiveAdminPhones(db);
  if (!phones.length) return;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev").replace(/\/$/, "");
  const adminPanelUrl = `${appUrl}/admin`;
  const text =
    `🏫 *New Student Registration Started*\n\n` +
    `*College:* ${collegeName}\n` +
    `*Student WhatsApp:* +${phone}\n` +
    (batchName ? `*Batch:* ${batchName}\n` : "") +
    (fee != null && fee > 0
      ? `*Fee:* ₹${fee.toLocaleString("en-IN")}\n\nStudent registration can start immediately.\n\n*Admin access:* Open the Admin Panel below to manage this registration.`
      : `*Fee:* Not set yet\n\n*How much should the registration fee be?* Reply with the amount only (for example: *2200*). No approval is needed — setting the amount activates the batch.`);
  await Promise.all(phones.map(async (p) => {
    const to = normalizeWhatsAppNumber(p);
    await sendWhatsAppText(to, text);
    if (fee != null && fee > 0) {
      await sendWhatsAppCtaButton(
        to,
        "Open the Student Platform Admin Panel to view and manage the registration.",
        "Open Admin Panel",
        adminPanelUrl,
        "Student Platform",
      );
    }
  }));
}

export async function notifyAdminOfCollegeRequest(
  db: SupabaseClient,
  collegeName: string,
  phone: string,
  matches: Array<{ name: string; description: string | null; website: string | null; wikipediaUrl: string | null; source: string }>,
): Promise<void> {
  const phones = await getActiveAdminPhones(db);
  if (!phones.length) return;

  const lines = matches.length
    ? matches.map((m, i) => {
        const details = [
          m.description ? `Description: ${m.description}` : null,
          m.website ? `Website: ${m.website}` : null,
          m.wikipediaUrl ? `Wikipedia: ${m.wikipediaUrl}` : null,
          `Source: ${m.source}`,
        ].filter(Boolean).join("\n");
        return `*${i + 1}. ${m.name}*\n${details}`;
      })
    : ["No reliable Wikidata match found. Please verify the college manually online before adding it."];

  const text =
    `🏫 *College not listed — review required*\n\n` +
    `*Student requested:* ${collegeName}\n` +
    `*Phone:* +${phone}\n\n` +
    `*Online lookup:*\n${lines.join("\n\n")}\n\n` +
    // Naming the exact command matters: this alert previously ended at "add it
    // to the supported-college list", an admin replied "Add then", and the bot
    // had nothing to match and asked them to clarify. An alert that asks for an
    // action must say how to perform it.
    `*To add it:* reply *ADD COLLEGE ${collegeName}*\n` +
    `Verify the institution is real first — this makes it selectable by every student.`;

  await Promise.all(phones.map(p => sendWhatsAppText(normalizeWhatsAppNumber(p), text)));
}

export async function notifyAdminOfWaitlistJoin(
  db: SupabaseClient,
  college: string,
  waitingCount: number,
  isFirstInQueue: boolean,
): Promise<void> {
  const phones = await getActiveAdminPhones(db);
  if (!phones.length) return;

  const text = isFirstInQueue
    ? `⏳ *Waiting queue started*\n\n*College:* ${college}\n*Waiting Students:* ${waitingCount}\n\nNo active batch right now. Reply \`CREATE\` to open a new batch for ${college}.`
    : `⏳ *Waiting queue update*\n\n*College:* ${college}\n*Waiting Students:* ${waitingCount}`;

  await Promise.all(phones.map(p => sendWhatsAppText(normalizeWhatsAppNumber(p), text)));
}

/** Admin log for each mute applied — visibility so genuine users aren't accidentally silenced. */
export async function notifyAdminOfMute(
  phone: string, name: string | null, warnings: number, durationLabel: string,
  db?: SupabaseClient
): Promise<void> {
  const phones = db ? await getActiveAdminPhones(db) : [];
  if (!phones.length) return;
  const text = `🔇 Student muted\n\n*Student:* ${name ?? "Unknown"}\n*Phone:* +${phone}\n*Warnings:* ${warnings}\n*Duration:* ${durationLabel}`;
  await Promise.all(phones.map(p => sendWhatsAppText(normalizeWhatsAppNumber(p), text)));
}

/** Admin log when a student is flagged for review. */
export async function notifyAdminFlaggedForReview(
  db: SupabaseClient, phone: string, reason: string,
): Promise<void> {
  const phones = await getActiveAdminPhones(db);
  if (!phones.length) return;
  const text = `⚠️ *Student flagged for review*\n\n*Phone:* +${phone}\n*Reason:* ${reason}`;
  await Promise.all(phones.map(p => sendWhatsAppText(normalizeWhatsAppNumber(p), text)));
}

/** Parse and execute an admin command. Returns true if handled. */
export async function handleAdminCommand(
  db: SupabaseClient,
  waFrom: string,
  text: string
): Promise<boolean> {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();

  // Checked first: an in-progress or newly-started (CREATE) batch draft
  // consumes this message outright, before any other command pattern
  // gets a chance to misinterpret a bare number or YES/EDIT/CANCEL reply.
  if (await handleAdminBatchFlow(db, waFrom, text)) return true;

  // ── Old-student block ─────────────────────────────────────────────────
  // Typed equivalent of the Bot Controls row. Same SUPER_ADMIN restriction as
  // the kill switch — it changes what the bot does for every closed batch.
  if (/^(OLD\s*STUDENTS?|BLOCK\s*OLD|ALLOW\s*OLD)\b/i.test(trimmed)) {
    const actor = await getAdmin(db, waFrom);
    if (actor?.role !== "SUPER_ADMIN") {
      await sendWhatsAppText(waFrom, "❌ Only a SUPER_ADMIN can change this.");
      return true;
    }
    const { isClosedBatchBlockEnabled, setClosedBatchBlockEnabled } = await import("@/lib/closed-batch-gate");

    if (/BLOCK\s*OLD|OLD\s*STUDENTS?\s*(OFF|BLOCK)/i.test(trimmed)) {
      await setClosedBatchBlockEnabled(db, true);
      await sendWhatsAppText(waFrom, "🚫 *Old students blocked.*\n\nStudents in a closed batch get one message explaining it, then the bot ignores them. Their dashboard and Route Map still work.");
      return true;
    }
    if (/ALLOW\s*OLD|OLD\s*STUDENTS?\s*(ON|ALLOW)/i.test(trimmed)) {
      await setClosedBatchBlockEnabled(db, false);
      await sendWhatsAppText(waFrom, "✅ *Old students allowed.*\n\nStudents in closed batches can use the bot normally again.");
      return true;
    }
    const blocking = await isClosedBatchBlockEnabled(db);
    await sendWhatsAppButtons(
      waFrom,
      blocking
        ? "🚫 Old students are *BLOCKED* — closed-batch students get one notice, then silence.\n\nAllow them back?"
        : "✅ Old students are *ALLOWED* — closed-batch students can use the bot.\n\nBlock them?",
      blocking
        ? [{ id: "adm_oldstu_off", title: "✅ Allow them" }, { id: "adm_bot_cancel", title: "Cancel" }]
        : [{ id: "adm_oldstu_on",  title: "🚫 Block them" }, { id: "adm_bot_cancel", title: "Cancel" }],
    );
    return true;
  }

  // ── Bot kill switch ───────────────────────────────────────────────────
  // Typed equivalents of the menu's Stop/Start rows. Also accepts the natural
  // phrasings an admin reaches for in a hurry ("kill switch", "stop bot").
  if (/^(BOT\s*(ON|OFF|STATUS)|KILL\s*SWITCH|STOP\s*(THE\s*)?BOT|START\s*(THE\s*)?BOT)\b/i.test(trimmed)) {
    // SUPER_ADMIN only — silencing the bot affects every student, so it carries
    // the same restriction as managing the admin roster. Checked on the typed
    // command too, not just the menu row, which a regular admin never sees.
    const actor = await getAdmin(db, waFrom);
    if (actor?.role !== "SUPER_ADMIN") {
      await sendWhatsAppText(waFrom, "❌ Only a SUPER_ADMIN can stop or start the bot.");
      return true;
    }
    const { setBotEnabled } = await import("@/lib/whatsapp/admin-menu");
    const { isWhatsAppBotEnabled } = await import("@/lib/services/payment-settings");
    const current = await isWhatsAppBotEnabled(db);

    if (/BOT\s*OFF|STOP\s*(THE\s*)?BOT/i.test(trimmed)) {
      await setBotEnabled(db, false);
      await sendWhatsAppText(waFrom, "🛑 *Bot stopped.*\n\nStudents now get no replies at all — they are not told why. Reply *BOT ON* (or use the menu) to resume.");
      return true;
    }
    if (/BOT\s*ON|START\s*(THE\s*)?BOT/i.test(trimmed)) {
      await setBotEnabled(db, true);
      await sendWhatsAppText(waFrom, "🟢 *Bot started.* It is replying to students again.");
      return true;
    }
    // "KILL SWITCH" / "BOT STATUS" — show state and offer the toggle.
    await sendWhatsAppButtons(
      waFrom,
      current
        ? "🟢 The bot is *LIVE* — replying to students.\n\nStop it?"
        : "🛑 The bot is *STOPPED* — students get no replies.\n\nStart it again?",
      current
        ? [{ id: "adm_bot_off", title: "🛑 Stop bot" }, { id: "adm_bot_cancel", title: "Cancel" }]
        : [{ id: "adm_bot_on",  title: "🟢 Start bot" }, { id: "adm_bot_cancel", title: "Cancel" }],
    );
    return true;
  }

  // ── ADD ADMIN <phone> / REMOVE ADMIN <phone> / ADMINS ─────────────────
  if (/^(ADD|REMOVE|DELETE)\s*ADMIN\b/i.test(trimmed)) {
    const isRemove = /^(REMOVE|DELETE)/i.test(trimmed);
    const m = trimmed.match(/^(?:ADD|REMOVE|DELETE)\s*ADMIN\s+(\+?[\d\s-]{7,15})/i);
    if (!m) {
      // No number given — don't answer with syntax to retype. Remove can be
      // finished entirely by tapping; Add asks for just the number.
      const { promptAddAdmin, promptRemoveAdmin } = await import("@/lib/whatsapp/admin-menu");
      if (isRemove) await promptRemoveAdmin(db, waFrom);
      else await promptAddAdmin(db, waFrom);
      return true;
    }
    const { addAdmin, removeAdmin } = await import("@/lib/whatsapp/admin-menu");
    const actor = await getAdmin(db, waFrom);
    if (!actor) { await sendWhatsAppText(waFrom, "❌ Could not verify your admin account."); return true; }
    await sendWhatsAppText(waFrom, isRemove
      ? await removeAdmin(db, actor, m[1])
      : await addAdmin(db, actor, m[1]));
    return true;
  }

  if (/^(ADMINS|LIST\s*ADMINS|MANAGE\s*ADMINS)\b/i.test(trimmed)) {
    // Same tappable roster the menu row gives — typing the command shouldn't
    // land you back in "now type ADD ADMIN <phone>".
    const { sendAdminRoster } = await import("@/lib/whatsapp/admin-menu");
    await sendAdminRoster(db, waFrom);
    return true;
  }

  // ── QUESTIONS ─────────────────────────────────────────────────────────
  // The open-question queue. Same list the "Student Questions" menu row shows —
  // typing the word shouldn't be a worse experience than tapping.
  if (/^(QUESTIONS?|OPEN\s*QUESTIONS?|UQ|ASKED)\b$/i.test(trimmed)) {
    const { buildOpenQuestionsMessage } = await import("@/lib/whatsapp/open-questions");
    await sendWhatsAppText(waFrom, await buildOpenQuestionsMessage(db));
    return true;
  }

  // ── ANSWER UQ-104\n<answer> ───────────────────────────────────────────
  // The answer may follow on the next line (what the prompt asks for) or on the
  // same line — an admin typing on a phone shouldn't have to know which. Any
  // input starting with ANSWER is captured here so a malformed one gets help
  // rather than falling through to "unknown command" (bug #33 class).
  if (/^ANSWER\b/i.test(trimmed)) {
    const answerMatch = trimmed.match(/^ANSWER\s+(?:UQ[-\s]?)?(\d+)[\s:.\-]*([\s\S]*)$/i);
    if (!answerMatch) {
      const { buildOpenQuestionsMessage } = await import("@/lib/whatsapp/open-questions");
      await sendWhatsAppText(waFrom, await buildOpenQuestionsMessage(db));
      return true;
    }

    const shortNum = parseInt(answerMatch[1], 10);
    const displayId = `UQ-${String(shortNum).padStart(3, "0")}`;
    const answer = (answerMatch[2] ?? "").trim();

    const { data: uq } = await db
      .from("unknown_questions")
      .select("id, question, short_id, student_phone")
      .eq("short_id", shortNum)
      .eq("status", "pending")
      .maybeSingle();

    if (!uq) {
      // Don't dead-end on a mistyped id — show what is actually open.
      const { buildOpenQuestionsMessage } = await import("@/lib/whatsapp/open-questions");
      await sendWhatsAppText(
        waFrom,
        `❌ ${displayId} isn't open — it may already be answered.\n\n` +
        (await buildOpenQuestionsMessage(db)),
      );
      return true;
    }

    // ID recognised but no answer typed yet: show the question so the admin can
    // read it and reply, instead of guessing what UQ-045 was about.
    if (!answer) {
      await sendWhatsAppText(
        waFrom,
        `❓ *${displayId}*\n\n"${uq.question}"\n\n` +
        `Send your answer like this:\n\n*ANSWER ${displayId}*\nyour answer here`,
      );
      return true;
    }

    const result = await answerUnknownQuestion(db, uq.id, answer);
    if (!result) {
      await sendWhatsAppText(waFrom, `❌ Failed to save answer. Try again.`);
      return true;
    }

    // Update answered_at and answered_by
    await db.from("unknown_questions").update({
      answered_at: new Date().toISOString(),
      answered_by: waFrom,
    }).eq("id", uq.id);

    // A student who asked inside the Student App gets the answer in that
    // same in-app thread (and a notification), not only on WhatsApp.
    await deliverAnswerToAppThreads(db, [uq.id], answer);

    // Send the answer back to the student who actually asked — previously
    // only future askers benefited from an answered question; the
    // original asker was left on "you'll hear back soon" forever unless
    // manually messaged. student_phone is only set for WhatsApp-sourced
    // questions (Mini App-submitted ones don't have a WhatsApp number to
    // reply to), so this is best-effort, not guaranteed for every UQ.
    if (uq.student_phone) {
      try {
        await sendWhatsAppText(
          uq.student_phone,
          `Hi! We have an answer to your question:\n\n"${uq.question}"\n\n${answer}`
        );
      } catch (err) {
        console.error(`Failed to notify original student for ${displayId}:`, (err as Error).message);
        // Don't fail the admin's ANSWER command over this — the FAQ is
        // already saved and future students are already covered. Just
        // let the admin know the notify-back specifically didn't land.
        await sendWhatsAppText(waFrom, `⚠️ Saved, but couldn't reach the original student to notify them.`);
      }
    }

    // Roll straight into what's still open — answering these is a sitting
    // exercise, and having to tap back into the menu between each one is what
    // leaves a queue unanswered.
    const { countOpenQuestions } = await import("@/lib/whatsapp/open-questions");
    const remaining = await countOpenQuestions(db);

    await sendWhatsAppText(
      waFrom,
      `✅ *${displayId} answered and saved as FAQ.*\n\nQuestion: ${uq.question}\nAnswer: ${answer}\n\nFuture students get this automatically.` +
      `${uq.student_phone ? "" : "\n\n(No WhatsApp number on file for the original asker — this came from the Mini App, so they won't get an automatic notification.)"}` +
      `${remaining > 0 ? `\n\n❓ *${remaining} question${remaining === 1 ? "" : "s"} still open* — send *QUESTIONS* to see them.` : "\n\n🎉 That was the last open question."}`
    );
    return true;
  }

  // ── DRAFTS ────────────────────────────────────────────────────────────
  // Self-learning FAQ queue: the assistant saves a draft every time it
  // successfully answers a question that had no FAQ match at all — never
  // live automatically, an admin approves or rejects each one here first.
  if (/^(DRAFTS?|FAQ\s*DRAFTS?|PENDING\s*FAQS?)\b$/i.test(trimmed)) {
    const { buildDraftFaqsMessage } = await import("@/lib/whatsapp/draft-faqs");
    await sendWhatsAppText(waFrom, await buildDraftFaqsMessage(db));
    return true;
  }

  // ── APPROVE <id> ──────────────────────────────────────────────────────
  const approveMatch = trimmed.match(/^APPROVE\s+([a-f0-9-]{4,})$/i);
  if (approveMatch) {
    const { approveDraftFaq, buildDraftFaqsMessage } = await import("@/lib/whatsapp/draft-faqs");
    const result = await approveDraftFaq(db, approveMatch[1]);
    if (!result) {
      await sendWhatsAppText(waFrom, `❌ No single pending draft matches "${approveMatch[1]}". Send *DRAFTS* to see current ids.`);
      return true;
    }
    await sendWhatsAppText(
      waFrom,
      `✅ *Live.* "${result.question}"\n\nFuture students asking something similar get this automatically now.\n\n${await buildDraftFaqsMessage(db)}`,
    );
    return true;
  }

  // ── REJECT <id> ───────────────────────────────────────────────────────
  const rejectMatch = trimmed.match(/^REJECT\s+([a-f0-9-]{4,})$/i);
  if (rejectMatch) {
    const { rejectDraftFaq, buildDraftFaqsMessage } = await import("@/lib/whatsapp/draft-faqs");
    const result = await rejectDraftFaq(db, rejectMatch[1]);
    if (!result) {
      await sendWhatsAppText(waFrom, `❌ No single pending draft matches "${rejectMatch[1]}". Send *DRAFTS* to see current ids.`);
      return true;
    }
    await sendWhatsAppText(waFrom, `🗑️ Discarded: "${result.question}"\n\n${await buildDraftFaqsMessage(db)}`);
    return true;
  }

  // ── RESTRICT PERMANENT <phone> ───────────────────────────────────────
  const restrictMatch = trimmed.match(/^RESTRICT\s+PERMANENT\s+(\+?\d[\d\s-]{7,})$/i);
  if (restrictMatch) {
    const targetPhone = normalizePhone(restrictMatch[1]);
    const { data: row } = await db.from("whatsapp_moderation").select("phone, preferred_name")
      .eq("phone", targetPhone).maybeSingle();
    if (!row) {
      await sendWhatsAppText(waFrom, `❌ No moderation record for ${targetPhone}. Nothing to restrict.`);
      return true;
    }
    await db.from("whatsapp_moderation").update({
      permanently_restricted: true, updated_at: new Date().toISOString(),
    }).eq("phone", targetPhone);
    await sendWhatsAppText(waFrom, `🚫 Permanently restricted +${targetPhone}${row.preferred_name ? ` (${row.preferred_name})` : ""}.`);
    return true;
  }

  // ── UNRESTRICT <phone> ────────────────────────────────────────────────
  const unrestrictMatch = trimmed.match(/^UNRESTRICT\s+(\+?\d[\d\s-]{7,})$/i);
  if (unrestrictMatch) {
    const targetPhone = normalizePhone(unrestrictMatch[1]);
    await db.from("whatsapp_moderation").update({
      permanently_restricted: false, restricted_until: null, abuse_count: 0,
      restriction_count: 0, flagged_for_review_at: null, updated_at: new Date().toISOString(),
    }).eq("phone", targetPhone);
    await sendWhatsAppText(waFrom, `✅ Restrictions cleared for +${targetPhone}. Fresh start.`);
    return true;
  }


  // ── STUDENTS ─────────────────────────────────────────────────────────
  if (upper === "STUDENTS") {
    const { data: rows, count } = await db
      .from("profiles")
      .select("full_name, college, roll_number, is_profile_complete", { count: "exact" })
      // Students, plus any staff account that is itself enrolled. // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
      .or("role.eq.student,batch_id.not.is.null")
      .order("created_at", { ascending: false })
      .limit(8);
    const total = count ?? 0;
    if (!rows?.length) { await sendWhatsAppText(waFrom, "No students registered yet."); return true; }
    const lines = rows.map(r =>
      `• ${r.full_name ?? "(incomplete)"} | ${r.college ?? "?"} | ${r.roll_number ?? "-"} | ${r.is_profile_complete ? "✅" : "⏳"}`
    );
    await sendWhatsAppText(waFrom,
      `👤 *Students (${total} total)*\n\n${lines.join("\n")}\n\n_Last 8 shown. ✅=complete ⏳=pending_`
    );
    return true;
  }

  // ── PAYMENTS ──────────────────────────────────────────────────────────
  if (upper === "PAYMENTS") {
    const { data: rows, error: payErr } = await db
      .from("admin_payment_queue")
      .select("full_name, payment_status, amount, utr_number, batch_name")
      .order("submitted_at", { ascending: false })
      .limit(8);
    if (payErr) {
      // Don't let a transient query failure masquerade as "no payments" —
      // that reads as "the student didn't pay" when they actually did.
      console.error("[admin PAYMENTS] query failed", payErr);
      await sendWhatsAppText(waFrom, "⚠️ Couldn't load payments right now. Please try again in a moment.");
      return true;
    }
    if (!rows?.length) { await sendWhatsAppText(waFrom, "No payments found."); return true; }
    const lines = rows.map((r: any) => {
      const badge = r.payment_status === "approved" ? "✅" : r.payment_status === "rejected" ? "❌" : "⏳";
      return `${badge} ${r.full_name ?? "?"} | ₹${r.amount} | ${r.batch_name ?? "-"}`;
    });
    await sendWhatsAppText(waFrom, `💳 *Recent Payments*\n\n${lines.join("\n")}`);
    return true;
  }

  // ── PENDING ───────────────────────────────────────────────────────────
  if (upper === "PENDING") {
    const { data: rows, count } = await db
      .from("admin_payment_queue")
      .select("full_name, amount, utr_number, batch_name, submitted_at", { count: "exact" })
      .eq("payment_status", "submitted")
      .order("submitted_at", { ascending: true });
    const total = count ?? 0;
    if (!rows?.length) { await sendWhatsAppText(waFrom, "✅ No pending payments — all clear!"); return true; }
    const lines = (rows as any[]).map(r =>
      `• ${r.full_name ?? "?"} | ₹${r.amount} | UTR: ${r.utr_number ?? "-"}`
    );
    await sendWhatsAppText(waFrom,
      `⏳ *Pending Payments (${total})*\n\n${lines.join("\n")}\n\nOpen the admin panel to approve.`
    );
    return true;
  }

  // ── STATUS ────────────────────────────────────────────────────────────
  if (upper === "STATUS") {
    const [
      { count: students },
      { count: pending },
      { count: approved },
      { count: batches },
    ] = await Promise.all([
      db.from("profiles").select("id", { count: "exact", head: true }).not("batch_id", "is", null).eq("is_profile_complete", true), // Enrolment, not role — an admin can also be an enrolled student (services/enrollment.ts)
      db.from("payments").select("id", { count: "exact", head: true }).eq("status", "submitted"),
      db.from("payments").select("id", { count: "exact", head: true }).eq("status", "approved"),
      db.from("batches").select("id", { count: "exact", head: true }).eq("status", "active"),
    ]);
    await sendWhatsAppText(waFrom,
      `📊 *Platform Status*\n\n` +
      `👤 Students: ${students ?? 0}\n` +
      `⏳ Pending payments: ${pending ?? 0}\n` +
      `✅ Approved: ${approved ?? 0}\n` +
      `📋 Active batches: ${batches ?? 0}`
    );
    return true;
  }

  // ── CALLS / MISSED CALLS ──────────────────────────────────────────────
  if (/^(CALLS?|MISSED\s*CALLS?)\b/i.test(trimmed)) {
    const { recentMissedCalls } = await import("@/lib/whatsapp/calls");
    await sendWhatsAppText(waFrom, await recentMissedCalls(db));
    return true;
  }

  // ── WABROADCAST / WHATSAPP BROADCAST <message> ────────────────────────
  // Matched BEFORE plain BROADCAST, since "WHATSAPP BROADCAST ..." would
  // otherwise never reach here — and a Telegram-only send is not what was asked.
  if (/^(WA\s*BROADCAST|WHATSAPP\s*BROADCAST|BROADCAST\s*WHATSAPP)\b/i.test(trimmed)) {
    // [\s\S] rather than . with the /s flag: dotAll needs an es2018 target,
    // which this tsconfig doesn't set. Same behaviour, multi-line messages work.
    const m = trimmed.match(/^(?:WA\s*BROADCAST|WHATSAPP\s*BROADCAST|BROADCAST\s*WHATSAPP)\s+([\s\S]+)$/i);
    const message = m?.[1]?.trim() ?? "";
    if (!message) {
      await sendWhatsAppText(waFrom, "Usage: *WHATSAPP BROADCAST <your message>*\n\nSends to everyone who has messaged this bot.");
      return true;
    }
    await sendWhatsAppText(waFrom, "📤 Sending… this can take a minute.");
    const { broadcastWhatsApp, broadcastSummary } = await import("@/lib/whatsapp/broadcast");
    const result = await broadcastWhatsApp(db, message);
    await sendWhatsAppText(waFrom, broadcastSummary(result));
    return true;
  }

  // ── INSTALL BATCH <slug> ────────────────────────────────────────────────
  // Sends the batch's own students (by profiles.batch_id, not everyone who
  // has messaged the bot) a prompt to install the Student App. Matches by
  // slug so it works on a closed batch too, not just the active one.
  if (/^INSTALL\s*BATCH\b/i.test(trimmed)) {
    const m = trimmed.match(/^INSTALL\s*BATCH\s+(\S+)$/i);
    const slug = m?.[1]?.trim() ?? "";
    if (!slug) {
      await sendWhatsAppText(waFrom, "Usage: *INSTALL BATCH <slug>*\n\nSends everyone in that batch a prompt to install the Student App.");
      return true;
    }
    const { data: batch } = await db.from("batches").select("id, name, slug").eq("slug", slug).maybeSingle();
    if (!batch) {
      await sendWhatsAppText(waFrom, `❌ No batch found with slug *${slug}*.`);
      return true;
    }
    await sendWhatsAppText(waFrom, `📤 Sending install prompt to *${batch.name}*… this can take a minute.`);
    const { broadcastInstallToBatch, broadcastSummary } = await import("@/lib/whatsapp/broadcast");
    const result = await broadcastInstallToBatch(db, batch.id);
    await sendWhatsAppText(waFrom, `*${batch.name}*\n\n${broadcastSummary(result)}`);
    return true;
  }

  // ── ADD COLLEGE ───────────────────────────────────────────────────────
  // The "College not listed — review required" alert asks the admin to add the
  // college to the supported list, and until now there was no way to do it from
  // WhatsApp. Live-reported: an admin replied "Add then" to that alert and got
  // "Could you clarify what you'd…" — the bot had asked for an action it could
  // not perform, the same gap item #118 fixed for invented commands.
  if (/^ADD\s*COLLEGE\b/i.test(trimmed)) {
    const name = trimmed.replace(/^ADD\s*COLLEGE\b[:\s]*/i, "").trim();
    if (!name) {
      await sendWhatsAppText(
        waFrom,
        "Usage: *ADD COLLEGE <name>*\n\n" +
        "Example:\n*ADD COLLEGE GNITS*\n\n" +
        "This adds the college to the supported list so students can pick it during registration.",
      );
      return true;
    }

    const { addCollege } = await import("@/lib/services/colleges");
    const result = await addCollege(db, name);
    if (!result.ok) {
      await sendWhatsAppText(waFrom, `Could not add that college: ${result.reason}`);
      return true;
    }

    await sendWhatsAppText(
      waFrom,
      `✅ *${name}* is now a supported college (id: ${result.id})` +
      `${result.reactivated ? " — it already existed and has been re-activated." : "."}\n\n` +
      "Students can now pick it during registration. It has no batch yet — " +
      `reply *CREATE ${result.id}* to open one when you're ready.`,
    );
    return true;
  }

  // ── ACTIVE BATCH ──────────────────────────────────────────────────────
  // Live-reported: an admin typed "Active batch" and got an LLM lecture about
  // the batch lifecycle ("each college has exactly one active batch...")
  // instead of WHICH batch is active. It is a data question, so it gets data.
  if (/^ACTIVE\s*BATCH(?:ES)?\b/i.test(trimmed)) {
    const { data: rows } = await db
      .from("batches")
      .select("id, name, college, fee_amount")
      .eq("status", "active")
      .order("college", { ascending: true });
    const active = (rows ?? []) as Array<{ id: string; name: string; college: string; fee_amount: string | null }>;
    if (!active.length) {
      await sendWhatsAppText(waFrom, "No college has an active batch right now.");
      return true;
    }
    const { countableBatches } = await import("@/lib/whatsapp/paid-count");
    const counted = await countableBatches(db);
    const lines = active.map(b => {
      const enrolled = counted.find(c => c.id === b.id)?.enrolled ?? 0;
      // Fee state, never the amount — rule 8: the bot does not quote a fee.
      const fee = b.fee_amount == null ? "fee not set yet" : "fee set";
      return `*${b.name}* — ${enrolled} registered · ${fee}`;
    });
    await sendWhatsAppText(waFrom, `*Active batches*\n\n${lines.join("\n")}`);
    return true;
  }

  // ── TEMPLATE ──────────────────────────────────────────────────────────
  // Paid broadcast templates were removed (owner rule: free-only, 2026-10-26).
  // Broadcasts reach only students who messaged in the last 24 hours.
  if (/^TEMPLATE\b/i.test(trimmed)) {
    await sendWhatsAppText(
      waFrom,
      `ℹ️ *No broadcast template in use*\n\nBroadcasts are free-only: they reach only students who messaged in the last 24 hours.\n\nStudents outside the 24h window cannot be reached on WhatsApp — no paid template is configured, by choice.`
    );
    return true;
  }

  // ── GROUP LINK [<batch>: <url>] ───────────────────────────────────────
  // The bot cannot create a usable group itself — Meta's Groups API needs an
  // Official Business Account and caps a group at EIGHT participants, against
  // batches of 45+. So an admin creates a normal WhatsApp group and stores its
  // invite link here; it then goes out with every registration link.
  if (/^GROUP\s*LINK\b/i.test(trimmed)) {
    const { isValidGroupLink } = await import("@/lib/whatsapp/group-link");
    const { countableBatches, batchLabel } = await import("@/lib/whatsapp/paid-count");

    const norm0 = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
    const resolveBatch = async (wanted: string) => {
      const all = await countableBatches(db);
      const hit = all.filter(b =>
        norm0(batchLabel(b.college, b.name)) === norm0(wanted) || norm0(b.name) === norm0(wanted));
      return { hit, all };
    };

    // ── GROUP LINK SEND <batch> ─────────────────────────────────────────
    // The invite otherwise only goes out with a registration link, so it
    // reaches new registrations and nobody who registered earlier. This is
    // the catch-up, and it is deliberately admin-triggered — it messages
    // every enrolled student in the batch.
    const sendMatch = trimmed.match(/^GROUP\s*LINK\s+SEND\s+(.+)$/i);
    if (sendMatch) {
      const { hit, all } = await resolveBatch(sendMatch[1].trim());
      if (hit.length !== 1) {
        const names = all.map(b => `• ${batchLabel(b.college, b.name)}`).join("\n");
        await sendWhatsAppText(waFrom, `No single batch matches *${sendMatch[1].trim()}*.\n\n${names || "No batch has registered students yet."}`);
        return true;
      }
      const label = batchLabel(hit[0].college, hit[0].name);
      const { broadcastGroupLinkToBatch, broadcastSummary } = await import("@/lib/whatsapp/broadcast");
      const result = await broadcastGroupLinkToBatch(db, hit[0].id);
      if ("noLink" in result && result.noLink) {
        await sendWhatsAppText(waFrom, `❌ No group link is set for *${label}* yet.\n\nSet it first:\n*GROUP LINK ${label}: https://chat.whatsapp.com/XXXX*`);
        return true;
      }
      await sendWhatsAppText(waFrom, `*${label}* — group invite\n\n${broadcastSummary(result)}`);
      return true;
    }

    const m = trimmed.match(/^GROUP\s*LINK\s+([^:\n]+?)\s*:\s*(\S+)\s*$/i);

    if (!m) {
      // No arguments — show what is set, which is also how an admin checks it.
      const { data: rows } = await db
        .from("batches")
        .select("name, college, whatsapp_group_link")
        .neq("status", "archived")
        .order("college", { ascending: true });
      const lines = (rows ?? [])
        .filter((b: { name: string }) => !/\barchived\s+draft\b/i.test(String(b.name)))
        .map((b: { name: string; college: string; whatsapp_group_link: string | null }) =>
          `*${batchLabel(b.college, b.name)}* — ${b.whatsapp_group_link ?? "not set"}`);
      await sendWhatsAppText(
        waFrom,
        `*WhatsApp group links*\n\n${lines.join("\n") || "No batches."}\n\n` +
        `Set one with:\n*GROUP LINK GNITC Batch 1: https://chat.whatsapp.com/XXXX*\n\n` +
        `Create the group in WhatsApp yourself, then Group info → Invite via link → Copy link. ` +
        `It is sent with every registration link for that batch. Send *none* as the link to clear it.\n\n` +
        `Already-registered students do NOT get it automatically — send it to them with *GROUP LINK SEND <batch>*.`
      );
      return true;
    }

    const wanted = m[1].trim();
    const url = m[2].trim();
    const clearing = /^none$/i.test(url);
    if (!clearing && !isValidGroupLink(url)) {
      await sendWhatsAppText(
        waFrom,
        "❌ That is not a WhatsApp group invite link.\n\nIt must look like *https://chat.whatsapp.com/XXXXXXXX* — in the group, tap Group info → Invite via link → Copy link."
      );
      return true;
    }

    const { hit: matches, all: batches } = await resolveBatch(wanted);
    if (matches.length !== 1) {
      const names = batches.map(b => `• ${batchLabel(b.college, b.name)}`).join("\n");
      await sendWhatsAppText(waFrom, `No single batch matches *${wanted}*.\n\n${names || "No batch has registered students yet."}`);
      return true;
    }

    const { error } = await db
      .from("batches")
      .update({ whatsapp_group_link: clearing ? null : url })
      .eq("id", matches[0].id);
    const label = batchLabel(matches[0].college, matches[0].name);
    await sendWhatsAppText(
      waFrom,
      error
        ? "❌ Could not save that link. Please try again."
        : clearing
          ? `✅ Cleared the group link for *${label}*. It will no longer be sent.`
          : `✅ Saved. Every new *${label}* registration link now comes with the group invite too.`
    );
    return true;
  }

  // ── ANNOUNCE <batch>: <message> ───────────────────────────────────────
  // Live-reported: an admin asked the bot to announce something to GNITC
  // Batch 1 and was told to "use the /announce command in the admin WhatsApp
  // group" — a command that has never existed. There genuinely was no way to
  // post an announcement from WhatsApp, so this adds one rather than leaving
  // the bot to invent a route to it.
  if (/^ANNOUNCE\b/i.test(trimmed)) {
    const m = trimmed.match(/^ANNOUNCE\s+([^:\n]+?)\s*:\s*([\s\S]+)$/i);
    if (!m) {
      await sendWhatsAppText(
        waFrom,
        "Usage: *ANNOUNCE <batch>: <message>*\n\n" +
        "Example:\n*ANNOUNCE GNITC Batch 1: Once we reach 40 members we will stop payments and start the petition.*\n\n" +
        "Put a title on its own first line if you want one. Reply *ACTIVE BATCH* to see the batch names."
      );
      return true;
    }

    const wanted = m[1].trim();
    const { countableBatches, batchLabel } = await import("@/lib/whatsapp/paid-count");
    const batches = await countableBatches(db);
    const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
    const matches = batches.filter(b =>
      norm(batchLabel(b.college, b.name)) === norm(wanted) || norm(b.name) === norm(wanted),
    );
    if (matches.length !== 1) {
      const names = batches.map(b => `• ${batchLabel(b.college, b.name)}`).join("\n");
      await sendWhatsAppText(
        waFrom,
        matches.length
          ? `More than one batch matches *${wanted}*. Use the full name:\n\n${names}`
          : `No batch with registered students matches *${wanted}*.\n\n${names || "No batch has registered students yet."}`,
      );
      return true;
    }
    const batch = matches[0];

    // A first line on its own becomes the title, matching ANSWER's shape.
    const rest = m[2].trim();
    const nl = rest.indexOf("\n");
    const title = nl > 0 ? rest.slice(0, nl).trim() : "Announcement";
    const body = nl > 0 ? rest.slice(nl + 1).trim() : rest;
    if (!body) {
      await sendWhatsAppText(waFrom, "The announcement is empty — send the message after the colon.");
      return true;
    }

    const label = batchLabel(batch.college, batch.name);
    await sendWhatsAppText(waFrom, `📢 Posting to *${label}* (${batch.enrolled} students)…`);
    try {
      const { createAnnouncement } = await import("@/lib/services/announcements");
      const { normalizePhone } = await import("@/lib/services/students");
      const { data: author } = await db
        .from("profiles")
        .select("id")
        .eq("phone", normalizePhone(waFrom))
        .maybeSingle();
      const result = await createAnnouncement(
        db,
        { title, body, college: batch.college, batch_id: batch.id, priority: "normal" },
        author?.id ?? null,
        label,
      );
      await sendWhatsAppText(
        waFrom,
        `✅ Posted to *${label}*.\n\n` +
        `It is on their dashboard now, and ${result.pushSent} of ${result.recipients} were notified` +
        `${result.pushFailed ? ` (${result.pushFailed} failed)` : ""}.`,
      );
    } catch (e) {
      console.error("[admin] ANNOUNCE failed", e);
      await sendWhatsAppText(waFrom, "❌ Could not post that announcement. Please try again.");
    }
    return true;
  }

  // ── BROADCAST <message> ───────────────────────────────────────────────
  // Any input starting with the BROADCAST keyword is handled here so a bare
  // "BROADCAST" gets usage help rather than the generic "Unknown command".
  if (/^BROADCAST\b/i.test(trimmed)) {
    // [\s\S] rather than dotAll (/s): a broadcast is often multi-line and this
    // project's build target rejects the /s flag.
    const broadcastMatch = trimmed.match(/^BROADCAST\s+([\s\S]+)$/i);
    const message = broadcastMatch?.[1].trim() ?? "";
    if (!message) { await sendWhatsAppText(waFrom, "Usage: *BROADCAST <your message>*"); return true; }
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
    if (!BOT_TOKEN) { await sendWhatsAppText(waFrom, "❌ Telegram bot token not configured."); return true; }
    const { data: recipients } = await db
      .from("profiles")
      .select("telegram_id")
      .eq("bot_started", true)
      .not("telegram_id", "is", null);
    let sent = 0;
    for (const r of recipients ?? []) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: Number(r.telegram_id), text: `📢 ${message}`, parse_mode: "HTML" }),
        });
        const j = await res.json();
        if (j.ok) sent++;
      } catch { /* skip individual failures */ }
    }
    await sendWhatsAppText(waFrom, `✅ Broadcast sent to ${sent} students via Telegram.`);
    return true;
  }

  // ── END BATCH [COLLEGE] ───────────────────────────────────────────────
  // Admin-only way to close the current Active batch and open the next one
  // (Issue #1/#41). Same shared service the website dashboard uses, so the
  // one-Active-batch rule and the "new batch has no fee" behaviour are
  // identical across surfaces.
  const endBatchMatch = trimmed.match(/^END\s+BATCH(?:\s+([A-Za-z]+))?\s*$/i);
  if (endBatchMatch) {
    const collegeArg = endBatchMatch[1]?.toUpperCase();
    const { data: actives } = await db.from("batches")
      .select("id, name, college").eq("status", "active");

    if (!actives?.length) {
      await sendWhatsAppText(waFrom, "No active batches to end.");
      return true;
    }

    let target = null as { id: string; name: string; college: string } | null;
    if (collegeArg) {
      target = (actives as any[]).find(b => String(b.college).toUpperCase() === collegeArg) ?? null;
      if (!target) {
        const list = (actives as any[]).map(b => `• ${b.college}: ${b.name}`).join("\n");
        await sendWhatsAppText(waFrom, `❌ No active batch for *${collegeArg}*.\n\nActive batches:\n${list}\n\nReply *END BATCH <COLLEGE>*.`);
        return true;
      }
    } else if (actives.length === 1) {
      target = actives[0] as any;
    } else {
      const list = (actives as any[]).map(b => `• ${b.college}: ${b.name}`).join("\n");
      await sendWhatsAppText(waFrom, `Which college's batch do you want to end?\n\n${list}\n\nReply *END BATCH <COLLEGE>*.`);
      return true;
    }

    const result = await endBatchAndCreateNext(db, target!.id, null);
    if (!result.ok) {
      const { message, batchClosed } = describeEndBatchFailure(result.reason);
      await sendWhatsAppText(
        waFrom,
        batchClosed ? `⚠️ *${target!.name}* — ${message}` : `❌ Could not end *${target!.name}* — ${message}`,
      );
      return true;
    }

    // What actually happened: closed, the next batch, how many unpaid students
    // moved over, and whether the next batch can take payments (the fee carries
    // over, so it usually can — this used to say "not set yet" regardless).
    await sendWhatsAppText(waFrom, `🏁 ${endBatchSummaryLines(result, (s) => `*${s}*`).join("\n\n")}`);
    return true;
  }

  // ── MESSAGE <phone|name> <text> ─────────────────────────────────────────
  // Admin can send a WhatsApp message to any student directly from the bot,
  // by phone number OR by their registered full name — reported live: an
  // admin typing "Message Asha Rao" got bounced to phone-number usage
  // help even though the name is right there in profiles.full_name. Shares
  // its phone-vs-name parsing with the photo-caption path (parseRelayCommand
  // in admin-photo-relay.ts) so the two don't drift out of sync again.
  // Any input that starts with the MESSAGE keyword is handled here — even a
  // bare "MESSAGE" or a malformed one — so the admin gets usage help instead
  // of falling through to the generic "Unknown command" reply.
  if (/^MESSAGE\b/i.test(trimmed)) {
    const { parseRelayCommand } = await import("@/lib/whatsapp/admin-photo-relay");
    const { resolveStudentByNamePrefix, maskPhone } = await import("@/lib/whatsapp/recipient-lookup");
    const cmd = parseRelayCommand(trimmed);

    const usage =
      `Usage: *MESSAGE <phone> <text>*\nExample: MESSAGE 9876543210 Your payment has been received.\n\n` +
      `Or by name: *MESSAGE <student's full name> <text>*\nExample: MESSAGE Asha Rao Your payment has been received.\n\n` +
      `📷 To send a *photo*, attach it and put the same line in the caption.`;

    // "not_a_command" can't actually happen here (the /^MESSAGE\b/i test above
    // already guarantees it) — handled anyway so TS can narrow cmd cleanly below.
    if (cmd.kind === "not_a_command" || cmd.kind === "malformed") {
      await sendWhatsAppText(waFrom, usage);
      return true;
    }
    if (cmd.kind === "bad_phone") {
      await sendWhatsAppText(waFrom, `❌ Invalid phone number. Format: MESSAGE 9876543210 <your message>`);
      return true;
    }

    let rawPhone: string;
    let msgBody: string;
    let who = "";

    if (cmd.kind === "needs_name") {
      const resolution = await resolveStudentByNamePrefix(db, cmd.text);
      if (resolution.kind === "none") {
        await sendWhatsAppText(
          waFrom,
          `❌ I couldn't find a registered student by that name.\n\n${usage}`,
        );
        return true;
      }
      if (resolution.kind === "ambiguous") {
        const list = resolution.matches.map((m) => `• ${m.full_name} (${maskPhone(m.phone)})`).join("\n");
        await sendWhatsAppText(
          waFrom,
          `⚠️ More than one student is named *${resolution.nameQuery}*:\n\n${list}\n\nPlease resend using the full phone number instead.`,
        );
        return true;
      }
      if (!resolution.body) {
        await sendWhatsAppText(waFrom, `Type your message after the name too.\n\n${usage}`);
        return true;
      }
      rawPhone = resolution.match.phone;
      msgBody = resolution.body;
      who = resolution.match.full_name;
    } else {
      // cmd.kind === "ok"
      rawPhone = cmd.phone;
      msgBody = cmd.body;
      if (!msgBody) {
        await sendWhatsAppText(waFrom, usage);
        return true;
      }
    }

    const toPhone = normalizeWhatsAppNumber(rawPhone);
    const sent = await sendWhatsAppText(toPhone, msgBody);
    const label = who ? `*${who}* (+91${rawPhone})` : `+91${rawPhone}`;
    if (sent) {
      await sendWhatsAppText(waFrom, `✅ Message sent to ${label}`);
    } else {
      await sendWhatsAppText(waFrom, `❌ Failed to send message to ${label}. Check the number is on WhatsApp.`);
    }
    return true;
  }

  // ── LOGIN ─────────────────────────────────────────────────────────────
  // The admin panel session lives in whatever browser/WebView last
  // authenticated. Telegram's WebView has its own localStorage, completely
  // separate from Chrome's — an admin opening the panel in Chrome sees the
  // marketing page, not the dashboard, because there's no sp_token there.
  // This sends a one-time link (10 min, single-use) that logs them in on
  // whatever device/browser they open it in. waFrom is already a verified
  // admin at this point (checked before any command dispatch runs).
  if (upper === "LOGIN") {
    try {
      const { generateAdminLoginLink } = await import("@/lib/whatsapp/admin-login");
      const link = await generateAdminLoginLink(db, waFrom);
      // A real tappable button, not a pasted link to copy — and no browser
      // named in the copy: a cta_url button opens through the phone's own
      // link handling (whatever the admin actually uses — Chrome, Firefox,
      // Samsung Internet), never WhatsApp's own in-app browser, which is
      // the one thing that actually matters here (see comment above).
      const sent = await sendWhatsAppCtaButton(
        waFrom,
        "🔑 One-time admin login link (valid 10 minutes, single use).",
        "Admin Login",
        link,
      );
      if (!sent) {
        // Button send can fail (Meta hiccup, unsupported client) — the link
        // itself still works, so fall back to it rather than a dead end.
        await sendWhatsAppText(
          waFrom,
          `🔑 One-time admin login link (valid 10 minutes, single use):\n\n${link}\n\nOpen it in your phone's browser (not inside WhatsApp) to log in there.`
        );
      }
    } catch (e) {
      console.error("[admin] LOGIN command failed:", e);
      await sendWhatsAppText(waFrom, "❌ Couldn't generate a login link — please try again.");
    }
    return true;
  }

  // ── HELP / MENU ───────────────────────────────────────────────────────
  // Sends the TAPPABLE admin list (students already got native menus; admins
  // were stuck retyping commands from a wall of text). Typed commands all still
  // work. If the interactive send fails for any reason, fall back to the plain
  // text list so an admin is never left without options.
  if (upper === "HELP" || upper === "MENU" || upper === "COMMANDS") {
    const { sendAdminMenu } = await import("@/lib/whatsapp/admin-menu");
    try {
      await sendAdminMenu(db, waFrom);
    } catch (e) {
      console.error("[admin] interactive menu failed, falling back to text:", e);
      await sendWhatsAppText(
        waFrom,
        `🛠 *Admin Commands*\n\n` +
        `*STATUS* — Platform overview\n` +
        `*ACTIVE BATCH* — Which batch is active at each college\n` +
        `*ANNOUNCE <batch>: <message>* — Post an announcement to one batch\n` +
        `*GROUP LINK* — See/set each batch's WhatsApp group invite\n` +
        `*TEMPLATE* — Broadcast reach (free-only: last 24h only)\n` +
        `*GROUP LINK SEND <batch>* — Send that invite to already-registered students\n` +
        `*STUDENTS* — Recent student list\n` +
        `*PAYMENTS* — Recent payments\n` +
        `*PENDING* — Pending approvals\n` +
        `*CHECK <phone or name>* — Look up one student's registration + payment (or just send the 10-digit number)\n` +
        `*BOT OFF* / *BOT ON* — Stop or start the student bot _(super admin)_\n` +
        `*BLOCK OLD* / *ALLOW OLD* — Closed-batch students on/off _(super admin)_\n` +
        `*ADMINS* — See who has admin access\n` +
        `*ADD ADMIN <phone>* / *REMOVE ADMIN <phone>* _(super admin)_\n` +
        `*BROADCAST <msg>* — Send Telegram DM to all students\n` +
        `*WHATSAPP BROADCAST <msg>* — WhatsApp everyone who messaged the bot\n` +
        `*INSTALL BATCH <slug>* — Prompt one batch's students to install the app\n` +
        `*CALLS* — Missed calls and whether they were answered\n` +
        `*MESSAGE <phone> <text>* — WhatsApp a student (attach a photo to send one)\n` +
        `*END BATCH <COLLEGE>* — Close the active batch & open the next\n` +
        `*QUESTIONS* — See what students have asked\n` +
        `*ANSWER UQ-001*\n<your answer> — Answer a question and create FAQ\n` +
        `*DRAFTS* — FAQ answers the assistant learned, awaiting your review\n` +
        `*APPROVE <id>* / *REJECT <id>* — Approve or discard a learned draft\n` +
        `*RESTRICT PERMANENT <phone>* — Permanently block a number\n` +
        `*UNRESTRICT <phone>* — Clear restrictions on a number\n` +
        `*LOGIN* — Get a one-time link to open the admin panel in your browser`
      );
    }
    return true;
  }

  // Not a recognized admin command — signal "not handled" so the caller can
  // fall back to natural-language classification (STATUS queries) and, failing
  // that, show the admin command menu. (Do NOT send an "Unknown command" reply
  // here: an admin typing a plain question should get an answer/HELP, not a
  // dead-end error.)
  return false;
}

