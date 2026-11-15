import { SupabaseClient } from "@supabase/supabase-js";
import { ParsedWhatsAppMessage } from "@/lib/whatsapp/parser";
import { sendWhatsAppText, sendWhatsAppList, sendWhatsAppButtons, sendWhatsAppCtaButton, sendWhatsAppImage, WaMenuRow } from "@/lib/whatsapp/client";
import { findStudentByPhone, normalizePhone } from "@/lib/services/students";
import { getRegistrationStatus, RegistrationStatus } from "@/lib/services/registration";
import { getPaymentStatus, PaymentStatus } from "@/lib/services/payments";
import { getPetitionStatus, PetitionStatus } from "@/lib/services/petitions";
import { getBatchStatus, BatchStatus, ensurePendingSetupBatch, getCurrentActiveBatch } from "@/lib/services/batches";
import { getActiveColleges, getCollegeName } from "@/lib/services/colleges";
import { consumeCollegeSelectionToken, consumeLatestCollegeSelection } from "@/lib/whatsapp/college-selection";
import { joinWaitlist, getWaitlistCount } from "@/lib/services/waitlist";
import { recordUnknownQuestion, saveDraftFaq } from "@/lib/services/faq";
import { notifyAdminOfNewDraftFaq } from "@/lib/whatsapp/draft-faqs";
import { handleAdminCommand, notifyAdminWhatsApp, notifyAdminOfMute, notifyAdminFlaggedForReview, notifyAdminOfWaitlistJoin, notifyAdminOfCollegeRequest, notifySuperAdminOfRegistrationStart, getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { isIdReuploadTrigger, startIdReuploadFlow, handleIncomingIdReuploadImage } from "@/lib/whatsapp/id-reupload";
import { analyzeIncomingImage, analyzeIncomingImageWithUrl } from "@/lib/whatsapp/image-understanding";
import { getAdmin, bootstrapAdmins } from "@/lib/whatsapp/admin-service";
import { generateAdminLoginLink } from "@/lib/whatsapp/admin-login";
import { VERIFY_MESSAGE_RE, replyWithCodeToVerify } from "@/lib/whatsapp/verify-code";
import { moderateIncomingText, setAwaitingSupportMessage, consumeAwaitingSupportMessage, isWelcomeGreeting } from "@/lib/whatsapp/moderation";
import { getIntentClassifier, CONFIDENCE_THRESHOLD, generateGroundedAnswer, generateGroundedAnswerDetailed } from "@/lib/intent-engine";
import { extractWhatsAppAction, containsUnverifiedRupeeAmount, type WhatsAppAction } from "@/lib/whatsapp/ai-actions";
import { buildStudentSnapshot, snapshotToFacts, caseStatusText, type StudentSnapshot } from "@/lib/services/student-snapshot";
import { unsupportedOutcomeClaim } from "@/lib/case-outcome-guard";
import { getPaymentGateForBatch, isPetitionMinimumWorthStating } from "@/lib/services/payment-gate";
import { listFaqs } from "@/lib/services/faq";
import { retrieveRelevantFaqs } from "@/lib/services/faq-retrieval";
import { audiencesFor } from "@/lib/services/faq";
import { savePending, loadPending, clearPending } from "@/lib/whatsapp/pending-slots";
import { normaliseText, isExplicitMenuRequest, detectActionIntent, isFeeClarifyingReply, looksLikeRealQuestion, isAppLinkIntent } from "@/lib/whatsapp/rule-intent";
import { matchFixProblem, matchAppProblem, sendFixGuidePhoto, sendFixOptions, sendFixFor, type FixKey } from "@/lib/whatsapp/fix-guide";
import { handleAppProblem } from "@/lib/whatsapp/app-diagnose";
import { getRecentTurns, recordTurn } from "@/lib/whatsapp/conversation-memory";
import { handleAdminSelection, handleAdminPhoneCapture } from "@/lib/whatsapp/admin-menu";
import { answerStudentLookup } from "@/lib/whatsapp/student-lookup";
import { answerGatewayStatusQuestion } from "@/lib/whatsapp/gateway-status";
import { isWhatsAppBotEnabled } from "@/lib/services/payment-settings";
import { closedBatchGate, closedBatchNotice } from "@/lib/closed-batch-gate";
import { issueRegistrationToken, buildRegistrationLink } from "@/lib/registration-token";
import { askNameMessage, processExplanationMessage, hasHadProcessExplanation, markProcessExplained, resolveGreetingName, shortGreetingMessage } from "@/lib/whatsapp/onboarding";
import { batchLabel, getPaidCountForBatch, sendPaidCountCollegeChoices, sendPaidCountSummary, wantsAllBatches } from "@/lib/whatsapp/paid-count";
import { answerUnpaidList } from "@/lib/whatsapp/unpaid-list";
import { parseRegStatsQuery, parseBareDayWord, getDayStats, getEnrolledStudentTotal, formatDayStats } from "@/lib/admin-stats";
import { generateSupportBotReply, aboutAnotherStudent } from "@/lib/services/support-bot";
import { runUnifiedStudentAgentByPhone, runUnifiedStudentAgent, formatOwnStatus, isOwnStatusQuestion, extractMentionedPhones } from "@/lib/unified-agent";

const MENU_ROWS: WaMenuRow[] = [
  { id: "register", title: "Register for Petition", description: "Start petition registration" },
  { id: "app_login", title: "Log in to the app", description: "Get your login code on WhatsApp" },
  { id: "faq", title: "FAQs", description: "Frequently asked questions" },
  { id: "contact_support", title: "Contact Support", description: "Talk to Student Support" },
  { id: "fix_help", title: "Fix a problem", description: "OTP, login, site data — quick fixes" },
  { id: "app_problem", title: "App not working", description: "Check it and fix it here" },
];

/**
 * Always says what this platform IS before offering the options.
 *
 * "Hi. What do you need help with?" told a student nothing: most people
 * reaching this number have been handed it by a classmate and do not yet know
 * what it is for, and the full explanation only ever goes out once per phone
 * (processExplanationMessage), so everyone after their first message saw a bare
 * question. One line of agenda costs nothing and is the difference between a
 * menu that makes sense and three unexplained buttons.
 */
const MENU_AGENDA =
  "*Student Support*\n\n"
  + "This platform is for graduates whose original certificates are being withheld "
  + "because government fee-reimbursement funds are still pending. Students facing "
  + "this can register to be part of a petition seeking relief.\n\n"
  + "What would you like to do?";

async function showMenu(to: string, name?: string | null): Promise<void> {
  const body = name ? `Hi ${name}! 👋\n\n${MENU_AGENDA}` : MENU_AGENDA;
  await sendWhatsAppList(to, body, "Menu", MENU_ROWS);
}

/** The three "Stuck? Fix it in 2 minutes" options (see src/lib/whatsapp/fix-guide.ts). */
async function showFixOptions(to: string): Promise<void> { await sendFixOptions(to); }
function formatRegistrationStatus(s: RegistrationStatus): string { if (!s.isComplete) return "Your registration isn't complete yet — open the Student App to finish it."; return [`✅ Registered${s.fullName ? ` — ${s.fullName}` : ""}`, s.college ? `College: ${s.college}` : null, s.rollNumber ? `Roll No: ${s.rollNumber}` : null, `Batch: ${s.batchName ?? "Not assigned yet"}`].filter(Boolean).join("\n"); }
function formatPaymentStatus(s: PaymentStatus): string { const labels: Record<PaymentStatus["status"], string> = { paid: "✅ Paid", pending: "⏳ Pending", failed: "❌ Failed / needs attention", none: "No payment on record yet." }; const lines = [labels[s.status]]; if (s.amount != null) lines.push(`Amount: ₹${s.amount}`); if (s.transactionId) lines.push(`Ref: ${s.transactionId}`); return lines.join("\n"); }
function formatBatchStatus(s: BatchStatus): string { const seats = s.remaining == null ? "Unlimited seats" : `${s.remaining} seat(s) left of ${s.batch_limit}`; return `${s.name} (${s.college})\nStatus: ${s.status}\n${seats}`; }
function formatPetitionStatus(s: PetitionStatus): string { if (!s.hasPetition) return "No petition filed yet."; return `Status: ${s.status}` + (s.reviewNotes ? `\nNote: ${s.reviewNotes}` : ""); }
async function replyWithStudentLookup<T>(db: SupabaseClient, waFrom: string, phone: string, fetchStatus: (studentId: string) => Promise<T | null>, format: (status: T) => string): Promise<void> { const student = await findStudentByPhone(db, phone); if (!student) { await sendWhatsAppText(waFrom, "We don't have a registration under this number yet. Reply 'Register' to get started."); return; } const status = await fetchStatus(student.id); await sendWhatsAppText(waFrom, status ? format(status) : "Couldn't find that information right now."); }
async function setLastIntent(db: SupabaseClient, phone: string, intent: string): Promise<void> { await db.from("whatsapp_moderation").upsert({ phone: normalizePhone(phone), last_intent: intent, last_intent_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "phone" }); }

const PAID_COUNT_RE = /\b(?:how\s+many|number\s+of|count\s+of|count)\s+(?:students?\s+)?(?:did\s+)?(?:make\s+)?(?:the\s+)?payments?\b|\bhow\s+many\s+(?:students?\s+)?(?:have\s+)?paid\b|\bpaid\s+count\b|\bhow\s+many\s+paid\b|\bpayments\s+done\b/i;
// "B2" is how students actually write it — a bare letter B means "batch".
// The word boundaries keep "B2B" (no boundary after the digit) and a "B"
// inside another word from ever matching.
const BATCH_NUMBER_RE = /\b(?:batch\s*[-#]?\s*|b\s*)(\d+)\b/i;
/**
 * College names come from the DATABASE, never a hardcoded list.
 *
 * A literal /\b(GNITC|GNIT|BIET)\b/ silently stops understanding any college
 * added afterwards — BIET itself was added later and had to be un-hardcoded
 * twice already (items #101 and #107, the second on the voice path). The
 * alternation is built longest-first so "GNITC" can never be swallowed by the
 * "GNIT" branch, which is the specific way that bug bites here.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function collegeTokens(db: SupabaseClient): Promise<string[]> {
  const { data } = await db.from("batches").select("college");
  const ids = Array.from(new Set((data ?? [])
    .map((b: { college: string | null }) => String(b.college ?? "").toUpperCase())
    .filter(Boolean)));
  return ids.sort((a, b) => b.length - a.length);
}

function collegeTokenRe(tokens: string[]): RegExp | null {
  if (!tokens.length) return null;
  return new RegExp(`\\b(${tokens.map(escapeRe).join("|")})\\b`, "i");
}

function collegeAndNumberRe(tokens: string[]): RegExp | null {
  if (!tokens.length) return null;
  return new RegExp(`\\b(${tokens.map(escapeRe).join("|")})\\s*(?:batch\\s*[-#]?\\s*|b\\s*)?(\\d+)\\b`, "i");
}

function isPaidCountQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  // wantsAllBatches ("paid list", "who has paid", "paid so far") must count
  // as a direct match too — otherwise it falls through to admin-command
  // matching and then raw FAQ search, which is how "Paid list" previously
  // came back as a STUDENT FAQ answer to an admin (item #117).
  return PAID_COUNT_RE.test(t) || wantsAllBatches(t) || (/\bpaid\b/.test(t) && /\b(?:count|how\s+many|number)\b/.test(t));
}

// "Did I pay?" / "payment status" / "fee paid?" — the student asks about
// their OWN payment, not the batch count. Answered deterministically from
// their record (the menu's payment_status lookup) instead of letting the
// AI brain guess or the batch-count flow answer about other students.
// Deliberately plural-blind: "payments done" is the batch count (above);
// singular "payment done" with "my" lands here via "my payment".
const PERSONAL_PAYMENT_STATUS_RE =
  /\bpayment\s+status\b|\bdid\s+i\s+pay\b|\bhave\s+i\s+paid\b|\bfee\s+paid\b|\bmy\s+(?:payment|fee)\b/i;

async function answerPersonalPaymentStatus(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  text: string,
): Promise<boolean> {
  if (!PERSONAL_PAYMENT_STATUS_RE.test(text.trim())) return false;
  await replyWithStudentLookup(db, waFrom, phone, async (id) => getPaymentStatus(db, id), formatPaymentStatus);
  return true;
}

function isPaidCountFollowUp(text: string, tokens: string[]): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^for\s+batch(?:\s+\d+)?$/i.test(t)) return true;
  if (/^(?:batch\s*[-#]?\s*\d+|b\s*\d+|\d+)$/i.test(t)) return true;
  const withNumber = collegeAndNumberRe(tokens);
  const bare = collegeTokenRe(tokens);
  if ((withNumber && withNumber.test(t)) || (bare && bare.test(t))) return true;
  return false;
}

function extractBatchNumber(text: string, tokens: string[]): number | null {
  const explicit = text.match(BATCH_NUMBER_RE);
  if (explicit) return Number(explicit[1]);
  const withNumber = collegeAndNumberRe(tokens);
  const compact = withNumber ? text.match(withNumber) : null;
  return compact ? Number(compact[2]) : null;
}

function extractCollegeToken(text: string, tokens: string[]): string | null {
  const bare = collegeTokenRe(tokens);
  const m = bare ? text.match(bare) : null;
  return m ? m[1].toUpperCase() : null;
}

function normaliseBatchName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

async function getLastIntent(db: SupabaseClient, phone: string): Promise<string | null> {
  const { data } = await db.from("whatsapp_moderation").select("last_intent, last_intent_at").eq("phone", normalizePhone(phone)).maybeSingle();
  if (!data?.last_intent || !data.last_intent_at) return null;
  const age = Date.now() - new Date(data.last_intent_at).getTime();
  return age >= 0 && age <= 30 * 60 * 1000 ? String(data.last_intent) : null;
}

async function clearLastIntent(db: SupabaseClient, phone: string): Promise<void> {
  await db.from("whatsapp_moderation").update({ last_intent: null, last_intent_at: null, updated_at: new Date().toISOString() }).eq("phone", normalizePhone(phone));
}

async function findBatchForPaidCount(
  db: SupabaseClient,
  text: string,
  preFetchedTokens?: string[],
): Promise<{ batch: { id: string; name: string; college: string; batch_limit: number | null } | null; ambiguous: Array<{ name: string; college: string }> }> {
  // Resolves purely from the TEXT — no preferred/default batch shortcut here.
  // A student's own batch is applied by the caller (answerPaidCount's student
  // branch), never by this function silently substituting it in — otherwise
  // "GNITC Batch 2" could quietly resolve to the asker's own Batch 1 just
  // because they happen to be enrolled there (item #116).
  //
  // `preFetchedTokens` is a pure caching optimisation, not a resolution
  // shortcut: the caller (answerPaidCount) sometimes already fetched the
  // same token list a moment earlier for isPaidCountFollowUp, and reuses it
  // here instead of querying `batches` a second time for the same message.
  // When omitted, this fetches it itself exactly as before.
  const tokens = preFetchedTokens ?? await collegeTokens(db);
  const batchNumber = extractBatchNumber(text, tokens);
  const collegeToken = extractCollegeToken(text, tokens);

  const { data: batches } = await db
    .from("batches")
    .select("id, name, college, batch_limit")
    .neq("status", "archived")
    .order("college", { ascending: true })
    .order("created_at", { ascending: true });
  const all = (batches ?? []).filter((b: { name: string }) => !/\barchived\s+draft\b/i.test(String(b.name))) as Array<{ id: string; name: string; college: string; batch_limit: number | null }>;
  let candidates = all;

  if (collegeToken) candidates = candidates.filter(b => String(b.college).toUpperCase() === collegeToken);
  if (batchNumber != null) {
    candidates = candidates.filter(b => {
      const name = normaliseBatchName(b.name);
      return name === `batch ${batchNumber}` || new RegExp(`\\b(?:batch\\s*[-#]?\\s*|b\\s*)${batchNumber}\\b`, "i").test(b.name);
    });
  }

  if (candidates.length === 1) return { batch: candidates[0], ambiguous: [] };
  if (candidates.length > 1) return { batch: null, ambiguous: candidates.map(b => ({ name: b.name, college: b.college })) };
  return { batch: null, ambiguous: [] };
}

// The tappable college -> batch chooser (sendPaidCountCollegeChoices) and
// getPaidCountForBatch now come from lib/whatsapp/paid-count.ts — item #117's
// design, which this file had regressed away from (a "Restore WhatsApp router
// handler" commit pasted back a pre-#117 snapshot that duplicated both
// functions inline as a plain-text, unfiltered-by-enrolment chooser). Do not
// re-duplicate either here; import from paid-count.ts instead.

/**
 * The ambiguity question for the paid-count follow-up.
 *
 * When every candidate is the same batch number in different colleges
 * ("B2" on its own), the only missing fact is the college — list just
 * the colleges, not the batches. Otherwise list the matching batches
 * as before.
 */
function ambiguousBatchReply(
  ambiguous: Array<{ name: string; college: string }>,
  batchNumber: number | null,
): string {
  const sameNumber = batchNumber != null && ambiguous.every(b => {
    const name = normaliseBatchName(b.name);
    return name === `batch ${batchNumber}` || new RegExp(`\\b(?:batch\\s*[-#]?\\s*|b\\s*)${batchNumber}\\b`, "i").test(b.name);
  });
  if (sameNumber) {
    const colleges = Array.from(new Set(ambiguous.map(b => b.college)));
    return `Which college? Batch ${batchNumber} is in more than one college.\n\n${colleges.map(c => `• ${c}`).join("\n")}\n\nExample: *${colleges[0]} Batch ${batchNumber}*`;
  }
  const names = ambiguous.slice(0, 8).map(b => `• ${b.college} — ${b.name}`).join("\n");
  return `Please specify the college too.\n\n${names}\n\nExample: *GNITC Batch 1*`;
}

async function answerPaidCount(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  text: string,
  scope: "admin" | "student",
  studentBatchId?: string | null,
): Promise<boolean> {
  const lastIntent = await getLastIntent(db, phone);
  const direct = isPaidCountQuestion(text);
  // Fetched at most once per call (only when actually needed, same as
  // before) and reused by findBatchForPaidCount below instead of it
  // re-querying the same college token list a second time.
  const tokens = lastIntent?.startsWith("PAID_COUNT") ? await collegeTokens(db) : null;
  const followUp = tokens != null && isPaidCountFollowUp(text, tokens);
  if (!direct && !followUp) return false;

  // Paid-count is conversational. Keep the user/bot turns together so short replies like "2" or "GNITC 1" retain their meaning.
  await recordTurn(db, phone, "user", text).catch(() => {});
  const trackedReply = async (out: string) => {
    await sendWhatsAppText(waFrom, out);
    await recordTurn(db, phone, "bot", out).catch(() => {});
  };

  const isContextReply = !direct && followUp;
  if (isContextReply && /^for\s+batch$/i.test(text.trim())) {
    await trackedReply("Which batch number? Example: *GNITC Batch 1*.");
    await setLastIntent(db, phone, "PAID_COUNT");
    return true;
  }

  // Slot filling. When the bot asked "which college?" for "Batch 2", the
  // batch number is stored as pending state. A reply that only names the
  // college ("Gnit") is completed with that stored number, so it resolves to
  // GNIT Batch 2 instead of listing every GNIT batch.
  let resolveText = text;
  const pending = isContextReply ? await loadPending(db, phone, "paid_count") : null;
  const pendingBatch = pending?.batch ?? null;
  if (pendingBatch != null && extractBatchNumber(text, tokens ?? (await collegeTokens(db))) == null) {
    resolveText = `${text} Batch ${pendingBatch}`;
  }

  const { batch, ambiguous } = await findBatchForPaidCount(db, resolveText, tokens ?? undefined);

  // A student must never reach the cross-college ambiguity list or batch
  // chooser below (item #116) — those are correct for an admin, who
  // genuinely picks between batches, and wrong for a student, who is in
  // exactly one batch. Always answered from their OWN batch here, whatever
  // findBatchForPaidCount resolved (or failed to resolve) from their text.
  if (scope === "student") {
    if (!studentBatchId) {
      await trackedReply("You're not registered to a batch yet. Reply *Register* to get started.");
      await clearLastIntent(db, phone);
      return true;
    }
    const { data: ownBatch } = await db.from("batches").select("id, name, college").eq("id", studentBatchId).maybeSingle();
    if (!ownBatch) {
      await trackedReply("Couldn't find your batch right now. Please try again shortly.");
      await clearLastIntent(db, phone);
      return true;
    }
    const { paid, enrolled } = await getPaidCountForBatch(db, ownBatch.id);
    const prefix = batch && batch.id !== studentBatchId
      ? "You can only see the paid count for your own batch — here it is:\n\n"
      : "";
    await trackedReply(`${prefix}*${batchLabel(ownBatch.college, ownBatch.name)}*\n\n✅ ${paid} of ${enrolled} students have paid and confirmed their seats.`);
    await clearLastIntent(db, phone);
    return true;
  }

  // Admin only, from here down. "Paid list"/"who has paid" asks for the
  // whole picture rather than one batch (item #117) — checked before the
  // ambiguity list/chooser so it never falls through to either.
  if (wantsAllBatches(text)) {
    await sendPaidCountSummary(db, waFrom);
    await clearLastIntent(db, phone);
    return true;
  }

  // The two replies below re-read what the user named; a direct question
  // never fetched the college tokens, so fetch them here when missing.
  const toks = tokens ?? await collegeTokens(db);

  if (ambiguous.length) {
    const askedNumber = extractBatchNumber(text, toks);
    await trackedReply(ambiguousBatchReply(ambiguous, askedNumber));
    await setLastIntent(db, phone, "PAID_COUNT");
    if (askedNumber != null) await savePending(db, phone, "paid_count", { batch: askedNumber });
    return true;
  }
  if (!batch) {
    // They named a college + a batch number that doesn't exist — say so
    // plainly (with that college's real batches) instead of silently
    // showing the chooser, which reads as if the question was ignored.
    const namedNumber = extractBatchNumber(text, toks);
    const namedCollege = extractCollegeToken(text, toks);
    if (namedCollege && namedNumber != null) {
      const { data: allBatches } = await db.from("batches").select("id, name, college").neq("status", "archived").order("created_at", { ascending: true });
      const list = (allBatches ?? []).filter((b: { name: string; college: string }) => String(b.college).toUpperCase() === namedCollege && !/\barchived\s+draft\b/i.test(String(b.name))).map((b: { name: string; college: string }) => `• ${b.college} — ${b.name}`).join("\n");
      await trackedReply(`There's no Batch ${namedNumber} in ${namedCollege}.${list ? `\n\nThe batches in ${namedCollege} are:\n\n${list}` : ""}\n\nExample: *${namedCollege} Batch 1*`);
      await setLastIntent(db, phone, "PAID_COUNT");
      return true;
    }
    // Tappable college -> batch list, not a typed-back plain-text dump
    // (item #117) — and scoped to batches with actual registered students,
    // so it never leads with an empty batch that can only answer "0 of 0".
    await sendPaidCountCollegeChoices(db, waFrom);
    await setLastIntent(db, phone, "PAID_COUNT");
    return true;
  }

  const { paid, enrolled } = await getPaidCountForBatch(db, batch.id);
  await trackedReply(`*${batchLabel(batch.college, batch.name)}*\n\n✅ ${paid} of ${enrolled} students have paid and confirmed their seats.`);
  await clearLastIntent(db, phone);
  await clearPending(db, phone).catch(() => {});
  return true;
}

/**
 * Admin registration statistics — "New registrations", "How many
 * registration done today", and the bare "Today"/"Yesterday" follow-up.
 * Deterministic (lib/admin-stats), ADMIN BRANCH ONLY: this is only ever
 * called after getAdmin() has recognised the sender, so a student number
 * can never reach it. Before this existed, "New registrations" fell past
 * every admin handler into the grounded LLM and came back as the student
 * registration flow, "how many ... today" was classified STATUS_REQUEST
 * and answered with all-time totals, and a bare "Today" lost all context.
 * The last-intent marker (same whatsapp_moderation store as PAID_COUNT)
 * is what lets a bare day word re-run the stats query for that day.
 */
const REG_STATS_INTENT = "ADMIN_REG_STATS";

async function answerAdminRegistrationStats(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  text: string,
): Promise<boolean> {
  const query = parseRegStatsQuery(text);
  let day: "today" | "yesterday" | null = null;
  if (query && query.day !== "total") {
    day = query.day;
  } else if (!query) {
    const bare = parseBareDayWord(text);
    if (!bare) return false;
    if ((await getLastIntent(db, phone)) !== REG_STATS_INTENT) return false;
    day = bare;
  }
  // "total" phrasings return false on purpose: they keep flowing to the
  // STATUS command / classifier below, whose totals use the same
  // enrolled definition (see lib/admin-stats.ts).
  if (!day) return false;

  const [stats, enrolled] = await Promise.all([getDayStats(db, day), getEnrolledStudentTotal(db)]);
  await sendWhatsAppText(waFrom, formatDayStats(day, stats, enrolled, true));
  await setLastIntent(db, phone, REG_STATS_INTENT).catch(() => {});
  return true;
}

async function sendProcessExplanationWithCta(db: SupabaseClient, waFrom: string, name: string | null): Promise<void> {
  await sendWhatsAppText(waFrom, processExplanationMessage(name));
  // MENU_ROWS, not a second copy: the option order is a product decision
  // (register, then FAQs, then Contact Support) and two inline lists drift.
  await sendWhatsAppList(waFrom, "Choose an option below:", "Options", MENU_ROWS);
}

function normaliseCollegeSearch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

async function handleCollegeSearchReply(db: SupabaseClient, waFrom: string, phone: string, text: string): Promise<void> {
  const requested = text.trim();
  const needle = normaliseCollegeSearch(requested);
  const colleges = await getActiveColleges(db);
  const scored = colleges.map(college => {
    const name = normaliseCollegeSearch(college.name);
    let score = 0;
    if (name === needle) score = 100;
    else if (name.startsWith(needle)) score = 80;
    else if (name.includes(needle)) score = 70;
    else { const tokens = needle.split(" ").filter(Boolean); const hits = tokens.filter(t => name.includes(t)).length; score = tokens.length ? Math.round((hits / tokens.length) * 60) : 0; }
    return { college, score };
  }).filter(x => x.score >= 50).sort((a, b) => b.score - a.score);
  if (scored.length === 1 || (scored.length > 0 && scored[0].score === 100)) { await sendStudentAppLinkOrWaitlist(db, waFrom, phone, scored[0].college.id, scored[0].college.name); return; }
  if (scored.length > 1) { const rows = scored.slice(0, 9).map(x => ({ id: "college_" + x.college.id, title: x.college.name, description: "Continue registration" })); await sendWhatsAppList(waFrom, "I found multiple supported colleges. Please select the correct one.", "Select College", rows); return; }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev";
  const searchUrl = appUrl + "/college-search?phone=" + encodeURIComponent(normalizePhone(phone));
  await sendWhatsAppCtaButton(
    waFrom,
    "I couldn't find that college in our supported list. Search the online college directory and select the correct institution. After you select it, return to WhatsApp to continue.",
    "Search College",
    searchUrl,
    "Student Support",
  );
}
async function handleWhatsAppSupportMessage(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  text: string,
  photo?: { url: string; description: string | null },
): Promise<void> {
  const student = await findStudentByPhone(db, phone).catch(() => null);
  const supportText = text.trim() || (photo?.description
    ? `📷 Photo attached. Vision analysis: ${photo.description}`
    : "📷 Photo attached.");

  if (student?.id) {
    const { data: row, error } = await db.from("student_queries").insert({
      student_id: student.id,
      telegram_id: null,
      name: student.full_name ?? null,
      message: supportText,
      batch_id: student.batch_id ?? null,
      college: student.college ?? null,
      last_message_at: new Date().toISOString(),
      last_sender: "student",
      source: "whatsapp",
      category: "support",
      priority: "normal",
      status: "open",
    }).select("id").single();

    if (!error && row) {
      await db.from("student_query_messages").insert({
        query_id: row.id,
        sender: "student",
        author_id: student.id,
        body: text.trim() || "📷 Photo",
        photo_url: photo?.url ?? null,
        photo_description: photo?.description ?? null,
      });

      // Give the student an immediate, grounded support answer. The vision
      // description is input to the same FAQ/database-aware support pipeline;
      // it is never treated as proof of payment or document validity. A
      // caption-less photo is NOT a question — generateSupportBotReply
      // short-circuits that case itself (see its own comment: feeding a bare
      // photo description in as "the question" produced fully hallucinated
      // answers in the in-app chat, same pipeline, same risk here).
      let reply = "Your support request has been sent to Student Support.";
      try {
        const result = await generateSupportBotReply(
          db, student.id, { caption: text, photoDescription: photo?.description ?? null }, [],
        );
        reply = result.reply;
      } catch (e) {
        console.error("[whatsapp/router] support bot reply failed:", (e as Error).message);
      }

      await db.from("student_query_messages").insert({
        query_id: row.id,
        sender: "bot",
        body: reply,
      });
      await db.from("student_queries").update({
        last_message_at: new Date().toISOString(),
        last_sender: "bot",
      }).eq("id", row.id);

      await sendWhatsAppText(waFrom, reply);
      return;
    }
  }

  const result = await recordUnknownQuestion(db, supportText, { phone });
  if (!result.saveFailed) {
    const { data: uq } = await db.from("unknown_questions").select("short_id").eq("id", result.id).maybeSingle();
    await notifyAdminWhatsApp(db, result.id, uq?.short_id ?? null, "Contact Support: " + supportText, phone, result.occurrenceCount).catch(() => {});
  }
  await sendWhatsAppText(waFrom, "Your support request has been sent to our team. We'll get back to you here.");
}
async function sendEvidenceIfRequested(waFrom: string, text: string): Promise<boolean> {
  if (!/\\b(evidence|proof|certificate|certificates|got.*certificate|received.*certificate|success.*case|success.*petition)\\b/i.test(text)) return false;
  const urls = [process.env.PETITION_EVIDENCE_IMAGE_1_URL, process.env.PETITION_EVIDENCE_IMAGE_2_URL].filter((u): u is string => !!u);
  if (!urls.length) {
    await sendWhatsAppText(waFrom, "Evidence photos are not available right now. Please contact support if you need the supporting documents.");
    return true;
  }
  await sendWhatsAppText(waFrom, "Here are supporting documents shared for reference. Personal identifiers have been redacted.");
  for (const url of urls) await sendWhatsAppImage(waFrom, url);
  return true;
}

/** Answer personal petition questions only from the sender's own phone-linked record.
 * A draft row is created automatically on batch assignment; it is NOT proof
 * that the student applied or that a court case was filed. */
function isPetitionProgressQuestion(text: string): boolean {
  return /\bpetition\b/i.test(text) && /\b(process|progress|status|appl(?:y|ied|ication)|filed|filing)\b/i.test(text);
}

async function answerPetitionProgress(
  db: SupabaseClient,
  student: Awaited<ReturnType<typeof findStudentByPhone>> | null,
): Promise<string> {
  if (!student) return "I couldn't find a student registration for this WhatsApp number. If you registered with another number, please use that number or ask Student Support to check it. I can't share an application status without a matching record.";
  const batch = student.batches;
  const lines: string[] = [];
  if (student.batch_id && batch) {
    lines.push(`Your batch: ${batch.name} (${batch.college}).`);
  } else {
    lines.push("I can't find an assigned batch for your registration yet.");
  }

  const { data: petition, error } = await db.from("petitions")
    .select("status, batch_id, review_notes")
    .eq("student_id", student.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[whatsapp/router] petition status lookup failed", error.message);
    lines.push("I can't check your petition application status right now. Please try again later or ask Student Support.");
  } else if (!petition) {
    lines.push("I can't find a petition application under your registration.");
  } else if (petition.batch_id !== student.batch_id) {
    lines.push("Your petition record doesn't match your current batch, so I can't confirm its status. Please ask Student Support to check it.");
  } else {
    const descriptions: Record<string, string> = {
      draft: "A draft record exists for you, but that alone does not mean you have applied or filed a petition.",
      pending_payment: "Your application is at the pending-payment step; it is not approved yet.",
      pending_review: "Your application is waiting for admin review; it is not approved yet.",
      approved: "Your application is approved in the Student Platform.",
      rejected: "Your application is marked rejected in the Student Platform.",
    };
    lines.push(descriptions[petition.status] ?? `Your recorded application status is ${petition.status}; ask Student Support what this means.`);
    if (petition.review_notes && (petition.status === "rejected" || petition.status === "pending_review")) {
      lines.push(`Review note: ${petition.review_notes}`);
    }
  }
  if (batch?.case_number && batch?.case_type && batch?.case_year) {
    lines.push(`Your batch has a court-case reference recorded: ${batch.case_type} ${batch.case_number}/${batch.case_year}. This is batch information, not proof of your individual application status.`);
    if (batch.case_status_url && /^https:\/\//i.test(batch.case_status_url)) {
      lines.push(`Court status link: ${batch.case_status_url}`);
    }
  } else {
    lines.push("I don't have a court-case reference for your batch, so I can't confirm a filing or court timeline.");
  }
  lines.push("The group petition needs enough students registered in the batch before it can move forward. I cannot give a filing date or court timeline from this record. Check your own details in the Student App; for the exact next step or a mismatch, ask Student Support.");
  return lines.join("\n\n");
}

async function handleFreeTextQuestion(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  text: string,
  // Threaded in from handleIncomingWhatsAppMessage, which already fetched
  // this same profile a moment earlier for the paid-count check — avoids a
  // second, identical findStudentByPhone round trip for the common case of a
  // genuine free-text question. `undefined` (never passed) means "fetch it
  // here"; an explicit `null` means "already checked, there is no student."
  preloadedStudent?: Awaited<ReturnType<typeof findStudentByPhone>> | null,
): Promise<void> {
  const { original, lower } = normaliseText(text);
  // "Stuck? Fix it in 2 minutes" — same problem check as the "genuine"
  // case above; this is the path taken when every AI provider is down.
  const fixProblem = matchFixProblem(original);
  if (fixProblem) {
    await sendFixFor(waFrom, fixProblem);
    await recordTurn(db, phone, "user", original);
    await recordTurn(db, phone, "bot", `fix-guide:${fixProblem}`);
    return;
  }
  // Same "app not working" diagnosis on the AI-down path — a generic
  // report must never end at "ask inside the Student App".
  if (matchAppProblem(original)) {
    const label = await handleAppProblem(db, waFrom, phone, original);
    await recordTurn(db, phone, "user", original);
    await recordTurn(db, phone, "bot", label);
    return;
  }
  if (await sendEvidenceIfRequested(waFrom, original)) return;
  if (isPetitionProgressQuestion(original)) {
    const student = preloadedStudent !== undefined
      ? preloadedStudent
      : await findStudentByPhone(db, phone).catch(() => null);
    const answer = await answerPetitionProgress(db, student);
    await sendWhatsAppText(waFrom, answer);
    await recordTurn(db, phone, "user", original);
    await recordTurn(db, phone, "bot", answer);
    return;
  }
  const priorHistory = await getRecentTurns(db, phone);
  await recordTurn(db, phone, "user", original);
  const reply = async (out: string) => { await sendWhatsAppText(waFrom, out); await recordTurn(db, phone, "bot", out); };
  // Unified Agent (shared brain, reply-only): deterministic own-status /
  // FAQ / other-student refusal for this phone-linked student, before
  // the grounded-LLM path. A handled answer is the ONLY reply to this
  // incoming message — no bulk or unsolicited send is added here.
  {
    const unified = await runUnifiedStudentAgentByPhone(db, phone, original).catch(() => null);
    if (unified?.handled) { await reply(unified.answer); return; }
  }
  const action = detectActionIntent(lower);
  if (action) {
    if (action === "register") await setLastIntent(db, phone, "MENU_REQUEST").catch(() => {});
    if (action === "menu") await showMenu(waFrom); else await handleMenuSelection(db, waFrom, phone, action);
    return;
  }
  // Role decides which FAQs this sender may see: students get public +
  // student answers, unknown numbers get public only.
  const roleStudent = preloadedStudent !== undefined ? preloadedStudent : await findStudentByPhone(db, phone).catch(() => null);
  const audiences = audiencesFor(roleStudent ? "student" : "unknown");
  const retrieval = await retrieveRelevantFaqs(db, original, priorHistory, audiences);
  const [studentCtx, knowledgeBase] = await Promise.all([
    Promise.resolve(roleStudent),
    Promise.resolve(retrieval.faqs),
  ]);
  let paymentStatus: string | null = null; if (studentCtx?.id) paymentStatus = await getPaymentStatus(db, studentCtx.id).then(p => p?.status ?? null).catch(() => null);
  const grounded = await generateGroundedAnswer(original, { name: studentCtx?.full_name ?? null, college: studentCtx?.college ?? null, batch: studentCtx?.batches?.name ?? null, paymentStatus, rollNumber: studentCtx?.roll_number ?? null, registrationComplete: studentCtx?.is_profile_complete ?? undefined }, priorHistory, knowledgeBase);
  if (grounded) {
    console.info("[whatsapp] reply", { path: "ai", retrieval: retrieval.method, faqCount: knowledgeBase.length });
    const { text: cleaned, action: taggedAction } = extractWhatsAppAction(grounded);
    if (cleaned) await reply(containsUnverifiedRupeeAmount(cleaned) ? "The exact amount for your batch is shown in the Student App's Payments tab." : cleaned);
    if (taggedAction) { await runWhatsAppAction(db, waFrom, phone, taggedAction, studentCtx); return; }
    if (!cleaned) return;
    if (looksLikeRealQuestion(original)) {
      saveDraftFaq(db, original, cleaned)
        .then(id => { if (id) notifyAdminOfNewDraftFaq(db, id, original, cleaned); })
        .catch(e => console.error("[router] saveDraftFaq failed", e));
    }
    return;
  }
  console.info("[whatsapp] reply", { path: "escalation", retrieval: retrieval.method, faqCount: knowledgeBase.length });
  const result = await recordUnknownQuestion(db, original, { phone }); if (result.saveFailed) { await reply("Sorry, something went wrong on our end. Please try again in a moment. 🙏"); return; }
  const { data: uq } = await db.from("unknown_questions").select("short_id").eq("id", result.id).maybeSingle();
  await notifyAdminWhatsApp(db, result.id, uq?.short_id ?? null, original, phone, result.occurrenceCount).catch(e => console.error("[router] admin question alert failed", e));
  await reply(buildUnknownReply(original));
}
/**
 * AI-first understanding for every free-text student message (item #221).
 * The grounded model reads the message with this student's real data and the
 * recent conversation, then answers — or ends with one [[DO:x]] tag that runs
 * an existing, proven handler (registration, statuses, counts, app login,
 * support, ID re-upload). Returns false ONLY when every AI provider is down,
 * so the caller can fall back to the old keyword routing.
 */
async function answerWithAiFirst(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  text: string,
  student: Awaited<ReturnType<typeof findStudentByPhone>> | null,
): Promise<boolean> {
  const { original } = normaliseText(text);
  if (await sendEvidenceIfRequested(waFrom, original)) return true;
  const priorHistory = await getRecentTurns(db, phone).catch(() => []);

  let facts: string | null = null;
  let caseInfo: StudentSnapshot["caseInfo"] = null;
  if (student?.id) {
    const snapshot = await buildStudentSnapshot(db, student.id).catch(() => null);
    if (snapshot) {
      if (aboutAnotherStudent(original, snapshot)) {
        const out = "I can only help with your own registration and payment, so I can't share or check anyone else's details. They can message this number from their own phone.";
        await sendWhatsAppText(waFrom, out);
        await recordTurn(db, phone, "user", original).catch(() => {});
        await recordTurn(db, phone, "bot", out).catch(() => {});
        return true;
      }
      // Unified Agent (shared brain): a "my status" question gets the
      // deterministic own-status answer from this same snapshot — no
      // extra DB round trip, no LLM, no rupee amount on WhatsApp.
      if (isOwnStatusQuestion(original)) {
        const out = formatOwnStatus(snapshot, "whatsapp");
        await sendWhatsAppText(waFrom, out);
        await recordTurn(db, phone, "user", original).catch(() => {});
        await recordTurn(db, phone, "bot", out).catch(() => {});
        return true;
      }
      // Other-student refusal via the shared guard as well, in case the
      // snapshot-based check above missed a differently phrased number.
      // Only run when a phone number is actually mentioned, so ordinary
      // questions do not pay for an extra FAQ lookup here.
      const unifiedGuard = extractMentionedPhones(original).length
        ? await runUnifiedStudentAgent(db, { role: "student", profileId: student.id, phone, channel: "whatsapp" }, original, { snapshot }).catch(() => null)
        : null;
      if (unifiedGuard?.handled && unifiedGuard.source === "other-student-refusal") {
        await sendWhatsAppText(waFrom, unifiedGuard.answer);
        await recordTurn(db, phone, "user", original).catch(() => {});
        await recordTurn(db, phone, "bot", unifiedGuard.answer).catch(() => {});
        return true;
      }
      facts = snapshotToFacts(snapshot, { hideAmounts: true });
      caseInfo = snapshot.caseInfo;
    }
  }

  const roleAudiences = audiencesFor(student ? "student" : "unknown");
  const retrieval = await retrieveRelevantFaqs(db, original, priorHistory, roleAudiences).catch(() => ({ faqs: [], method: "none" as const }));
  const outcome = await generateGroundedAnswerDetailed(
    original,
    {
      name: student?.full_name ?? null,
      college: student?.college ?? null,
      batch: student?.batches?.name ?? null,
      registrationComplete: student?.is_profile_complete ?? undefined,
      facts,
    },
    priorHistory,
    retrieval.faqs,
    "student",
    "whatsapp",
  );
  if (outcome.kind === "unavailable") {
    console.warn("[whatsapp] reply", { path: "ai_unavailable_fallback" });
    return false;
  }

  await recordTurn(db, phone, "user", original).catch(() => {});

  if (outcome.kind === "escalate") {
    console.info("[whatsapp] reply", { path: "ai_escalation", retrieval: retrieval.method });
    const result = await recordUnknownQuestion(db, original, { phone });
    const out = result.saveFailed ? "Sorry, something went wrong on our end. Please try again in a moment. 🙏" : buildUnknownReply(original);
    if (!result.saveFailed) {
      const { data: uq } = await db.from("unknown_questions").select("short_id").eq("id", result.id).maybeSingle();
      await notifyAdminWhatsApp(db, result.id, uq?.short_id ?? null, original, phone, result.occurrenceCount).catch(e => console.error("[router] admin question alert failed", e));
    }
    await sendWhatsAppText(waFrom, out);
    await recordTurn(db, phone, "bot", out).catch(() => {});
    return true;
  }

  let { text: reply, action } = extractWhatsAppAction(outcome.text);
  // Rule 8, last line of defence: no rupee amount ever leaves on WhatsApp.
  if (containsUnverifiedRupeeAmount(reply)) {
    console.warn("[whatsapp] reply had an unverified rupee amount — replaced (rule 8)");
    reply = "The exact amount for your batch is shown in the Student App's Payments tab.";
  }
  // Same idea for the court case: no win, loss or court direction the record doesn't show.
  if (unsupportedOutcomeClaim(reply, caseInfo)) {
    console.warn("[whatsapp] reply claimed a case outcome the court record does not show — replaced");
    reply = student?.id
      ? caseStatusText(caseInfo)
      : "I can't say how any court case turned out. Registered students can see the latest status of their batch's case on the Home screen of the Student App.";
  }
  console.info("[whatsapp] reply", { path: "ai", provider: outcome.provider, action, retrieval: retrieval.method });
  if (reply) {
    await sendWhatsAppText(waFrom, reply);
    await recordTurn(db, phone, "bot", reply).catch(() => {});
  }
  if (action) {
    await runWhatsAppAction(db, waFrom, phone, action, student);
  } else if (reply && looksLikeRealQuestion(original) && !student?.id) {
    // Only answers given without anyone's personal data may become FAQ drafts.
    saveDraftFaq(db, original, reply)
      .then(id => { if (id) notifyAdminOfNewDraftFaq(db, id, original, reply); })
      .catch(e => console.error("[router] saveDraftFaq failed", e));
  }
  if (!reply && !action) await showMenu(waFrom);
  return true;
}

/** Runs the one action the model asked for — always an existing handler. */
async function runWhatsAppAction(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  action: WhatsAppAction,
  student: Awaited<ReturnType<typeof findStudentByPhone>> | null,
): Promise<void> {
  switch (action) {
    case "menu": await showMenu(waFrom); return;
    case "paid_count": {
      if (!(await answerPaidCount(db, waFrom, phone, "how many paid", "student", student?.batch_id ?? null))) {
        await sendWhatsAppText(waFrom, "You aren't in a batch yet. Reply *Register* to join your college's batch.");
      }
      return;
    }
    case "id_reupload": await startIdReuploadFlow(db, waFrom, phone); return;
    case "register": await setLastIntent(db, phone, "MENU_REQUEST").catch(() => {}); await handleMenuSelection(db, waFrom, phone, "register"); return;
    default: await handleMenuSelection(db, waFrom, phone, action); return;
  }
}
function buildUnknownReply(question: string): string { const q = question.trim(); let snippet = q.length <= 60 ? q : q.slice(0, 60).replace(/\s\S*$/, "") + "…"; snippet = snippet.charAt(0).toUpperCase() + snippet.slice(1); return `Hmm, "${snippet}" isn't something I can answer confidently on my own — I've passed it to our team and someone will get back to you soon.\n\nIn the meantime, reply Menu if you want to check your registration, payment, petition, or batch status.`; }

/**
 * Sends the Student App link — the deterministic answer to "App link" /
 * "Link" / "download app" and similar. This is a keyword intent, NOT an AI
 * reply: the AI had no grounded app-link fact, so it wrote a reply with a
 * "[link]" placeholder (or "I'll send you the link"), which the output
 * guard replaced with the "I couldn't finish that reply" fallback (live
 * 9 Nov 2026, admin + students). The link is sent directly here, so it
 * works even when every AI provider is down.
 *
 * The link is a DIRECT one-tap app/install link, never the marketing
 * homepage (live 9 Nov 2026: the old bare-homepage link made a student
 * hunt for Sign in / Sign up). For a student the sender is looked up
 * first (sendDirectAppLink) so the link lands on the right screen for
 * them; for an admin the recipient is unknown, so it is the generic
 * one-tap install link. `role` tailors the line after the link only —
 * never any personal data.
 */
async function sendAppLink(db: SupabaseClient, waFrom: string, phone: string, role: "admin" | "student"): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev";
  if (role === "admin") {
    await sendWhatsAppCtaButton(waFrom, "Here's the Student App link. One tap installs the app — students sign in with their phone number and get their login code here on WhatsApp. Your admin panel is via *LOGIN*.", "Open Student App", `${appUrl}/install`, "Student Platform");
    return;
  }
  await sendDirectAppLink(db, waFrom, phone);
}

/**
 * The direct one-tap app/registration link for one sender, resolved from
 * who is asking — so one tap installs/opens the app at the right screen
 * instead of landing on the marketing page. Used by the "Register"
 * pre-check and the "App link" path alike, so both intents send the same
 * direct link.
 *
 * - Already registered → the install link landing on login (or the
 *   dashboard when they already have a session).
 * - Known college, registration unfinished → the registration-token link,
 *   which lands straight in registration in the app with the college
 *   already filled in (no active batch → waitlist, handled inside
 *   sendStudentAppLinkOrWaitlist).
 * - Brand-new / unknown → the install link landing straight on sign-up
 *   inside the app (name / phone / college).
 */
async function sendDirectAppLink(db: SupabaseClient, waFrom: string, phone: string): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev";
  // Fetch who is asking first — the link depends on their state.
  const student = await findStudentByPhone(db, phone).catch(() => null);
  // Already registered — straight to the app (login, or the dashboard
  // when they already have a session).
  if (student?.is_profile_complete) {
    await sendWhatsAppCtaButton(waFrom, "You're already registered. Here's the Student App — one tap to open it.", "Open Student App", `${appUrl}/install?next=/login`, "Student Platform");
    return;
  }
  // Known college, registration unfinished — the token link takes them
  // straight into registration in the app (college already filled in).
  if (student?.college) {
    const collegeName = await getCollegeName(db, student.college);
    await sendStudentAppLinkOrWaitlist(db, waFrom, phone, student.college, collegeName);
    return;
  }
  // Brand-new — one tap installs the app and lands straight on sign-up
  // inside it (name / phone / college). Never the marketing page.
  await sendWhatsAppCtaButton(waFrom, "Here's the Student App — one tap installs it, then sign up inside the app.", "Open Student App", `${appUrl}/install?next=/signup`, "Student Platform");
}

async function sendStudentAppLinkOrWaitlist(db: SupabaseClient, waFrom: string, phone: string, collegeId: string, collegeName: string): Promise<void> {
  const issued = await issueRegistrationToken(db, phone, collegeId);
  if (issued) {
    const link = buildRegistrationLink(issued);
    await sendWhatsAppCtaButton(waFrom, `Your ${collegeName} registration is ready.`, "Start Registration", link);
    return;
  }
  const { alreadyWaiting, position } = await joinWaitlist(db, collegeId, phone);
  await sendWhatsAppText(waFrom, `Registration is temporarily paused for *${collegeName}*.\n\n` + `You have been added to the waiting list${alreadyWaiting ? "" : ` (position ${position})`}.\n` + `You will automatically receive the Student App link on WhatsApp when the next batch opens.\n\n` + `No need to message again — we will reach out. 🙏`);
  const pendingBatchId = await ensurePendingSetupBatch(db, collegeId);
  if (!alreadyWaiting) {
    const { data: pending } = await db.from("batches")
      .select("id,name,status")
      .eq("college", collegeId)
      .eq("status", "pending_setup")
      .maybeSingle();
    if (pending) {
      const phones = await getActiveAdminPhones(db);
      await Promise.all(phones.map(async (p: string) => {
        const { error: draftError } = await db.from("whatsapp_moderation").upsert({
          phone: normalizePhone(p),
          admin_batch_draft: { step: "set_fee", batchId: pending.id, batchName: pending.name },
          updated_at: new Date().toISOString(),
        }, { onConflict: "phone" });
        if (draftError) console.error("[lib/whatsapp/router] fee prompt draft failed:", p, draftError);
        try {
          await sendWhatsAppText(p, `🏫 *New Student Registration*\n\n*College:* ${collegeName}\n*Student:* +${phone}\n*Batch:* ${pending.name}\n\n*How much should the registration fee be?* Reply with the amount only (for example: *2200*). No approval is needed — setting the amount activates the batch and releases waiting students.`);
        } catch (e) {
          console.error("[lib/whatsapp/router] fee prompt failed:", p, e);
        }
      }));
    }
  }
}
async function handleMenuSelection(db: SupabaseClient, waFrom: string, phone: string, id: string, profileName?: string | null): Promise<void> {
  // This is a menu action, not a college ID. Keep it ahead of the generic college_ prefix check.
  if (id === "college_not_listed") {
    await setLastIntent(db, phone, "COLLEGE_SEARCH");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev";
    const searchUrl = appUrl + "/college-search?phone=" + encodeURIComponent(normalizePhone(phone));
    await sendWhatsAppCtaButton(
      waFrom,
      "Select your college in the Student Platform. You can search the full college directory and tap the correct college. After selection, return here automatically to continue.",
      "Select College",
      searchUrl,
      "Student Platform",
    );
    return;
  }
  if (id.startsWith("college_")) { const college = id.replace("college_", ""); const collegeName = await getCollegeName(db, college); await sendStudentAppLinkOrWaitlist(db, waFrom, phone, college, collegeName); return; }
  switch (id) {
    case "about": { const name = await resolveGreetingName(db, phone, profileName); await sendProcessExplanationWithCta(db, waFrom, name); await markProcessExplained(db, phone); return; }
    case "faq": {
      const faqs = await listFaqs(db).catch(() => []);
      const evidenceFaq = {
        question: "Is there evidence that students have received their original certificates?",
        answer: "Yes. Supporting documents from students who collected their original certificates are available for reference. Personal identifiers should be treated as confidential. Ask the bot for “evidence” or “proof” to view the supporting photos."
      };
      const faqText = [
        ...faqs.map((f: any, i: number) => `${i + 1}. ${f.question}\n${f.answer}`),
        `${faqs.length + 1}. ${evidenceFaq.question}\n${evidenceFaq.answer}`
      ].join("\n\n");
      // Send the complete FAQ list in WhatsApp-safe chunks so later FAQs are not hidden.
      const chunks: string[] = [];
      let remaining = faqText;
      while (remaining.length > 3900) {
        let cut = remaining.lastIndexOf("\n\n", 3900);
        if (cut < 500) cut = 3900;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).trimStart();
      }
      if (remaining) chunks.push(remaining);
      for (const chunk of chunks) await sendWhatsAppText(waFrom, chunk);

      // The evidence FAQ itself should show the supporting photos, not require
      // the student to send another message asking for proof.
      const evidenceUrls = [
        process.env.PETITION_EVIDENCE_IMAGE_1_URL,
        process.env.PETITION_EVIDENCE_IMAGE_2_URL,
      ].filter((u): u is string => !!u);
      if (evidenceUrls.length) {
        await sendWhatsAppText(waFrom, "Evidence referenced in the FAQ:");
        for (const url of evidenceUrls) await sendWhatsAppImage(waFrom, url);
      }
      return;
    }
    case "fix_help": { await showFixOptions(waFrom); return; }
    case "app_problem": { await handleAppProblem(db, waFrom, phone, "app not working"); return; }
    // Replies to the diagnose "which screen?" question (buttons sent by
    // app-diagnose.ts). The pending slot carries the question; the id
    // carries the screen, so the diagnosis re-runs with that screen.
    case "app_screen_login": { await handleAppProblem(db, waFrom, phone, "Login / code screen"); return; }
    case "app_screen_inside": { await handleAppProblem(db, waFrom, phone, "After login — app opens but stuck"); return; }
    case "app_screen_payment": { await handleAppProblem(db, waFrom, phone, "Payment screen"); return; }
    case "menu": { await showMenu(waFrom); return; }
    case "fix_otp":
    case "fix_not_registered":
    case "fix_clear_data": { await sendFixFor(waFrom, id.replace("fix_", "") as FixKey); return; }
    case "contact_support": { await setAwaitingSupportMessage(db, phone); await sendWhatsAppText(waFrom, "Tell us briefly what you need help with. Your message will be sent to Student Support."); return; }
    case "register": {
      // Our OWN supported colleges, as tappable rows, answered without leaving
      // WhatsApp.
      //
      // This previously sent students to /college-search on the website, which
      // resolves a college against the live AICTE directory. That round trip
      // fails in ways a student cannot act on: reported live with a screenshot
      // where picking GNITC showed "That engineering college is not in the live
      // AICTE directory" in red and then hung on "Saving selection…". When the
      // AICTE fetch aborts — which it is doing on essentially every call — the
      // snapshot fallback has no row for GNITC at all, and the name for GNIT
      // matches three different institutions, so a student could be bound to
      // the wrong one.
      //
      // A student registering for one of OUR colleges never needed an external
      // directory: the colleges table is the authoritative list, and the
      // college_<id> handler below has always been able to take the answer.
      const colleges = await getActiveColleges(db);
      if (!colleges.length) {
        await sendWhatsAppText(waFrom, "No colleges are currently open for registration. Please contact Student Support.");
        return;
      }
      // Straight through when there is only one — a list of one is not a choice.
      if (colleges.length === 1) {
        await sendStudentAppLinkOrWaitlist(db, waFrom, phone, colleges[0].id, colleges[0].name);
        return;
      }
      // A LIST, not reply buttons: those cap at three, which this outgrows the
      // moment a fourth college is added — exactly how BIET arrived.
      const rows: WaMenuRow[] = colleges.slice(0, 9).map(c => ({
        id: "college_" + c.id,
        title: c.name.slice(0, 24),
        description: "Continue registration",
      }));
      // Kept last so someone we do not support still has a way forward
      // (handled by college_not_listed below) rather than a dead end.
      rows.push({ id: "college_not_listed", title: "My college isn't listed", description: "Tell us which college you're from" });
      await sendWhatsAppList(waFrom, "Which college are you from?", "Select College", rows);
      return;
    } case "app_login": {
      // "Log me in": the student tapped the menu's login option. Same as
      // messaging VERIFY — issue a login code on WhatsApp (the reply
      // opens the 24h window, so the code arrives). No link is ever minted.
      const menuAdmin = await getAdmin(db, waFrom).catch(() => null);
      await replyWithCodeToVerify(db, waFrom, { isAdmin: !!menuAdmin });
      return;
    }
    case "app_link": {
      // "App link" / "Link": send the Student App URL itself. Distinct from
      // app_login (which sends a code). Reached from the keyword fallback
      // (handleFreeTextQuestion) and from an AI [[DO:app_link]] tag.
      const linkAdmin = await getAdmin(db, waFrom).catch(() => null);
      await sendAppLink(db, waFrom, phone, linkAdmin ? "admin" : "student");
      return;
    }
    case "registration_status": await replyWithStudentLookup(db, waFrom, phone, async (id) => getRegistrationStatus(db, id), formatRegistrationStatus); return;
    case "payment_status": await replyWithStudentLookup(db, waFrom, phone, async (id) => getPaymentStatus(db, id), formatPaymentStatus); return;
    case "petition_status": await sendWhatsAppText(waFrom, await answerPetitionProgress(db, await findStudentByPhone(db, phone).catch(() => null))); return;
    case "batch_status": await replyWithStudentLookup(db, waFrom, phone, async (id) => getBatchStatus(db, id), formatBatchStatus); return;
    case "seat_count": {
      // "How many registered" — the student's OWN batch only (bug #43 / item
      // #116 shape). This case was missing, so the keyword route answered
      // "I didn't recognize that option".
      const student = await findStudentByPhone(db, phone).catch(() => null);
      if (!student?.batch_id) { await sendWhatsAppText(waFrom, "You aren't in a batch yet. Reply *Register* to join your college's batch."); return; }
      const gate = await getPaymentGateForBatch(db, student.batch_id);
      const minimumNote = isPetitionMinimumWorthStating(gate.required) ? ` The petition needs at least ${gate.required}.` : "";
      await sendWhatsAppText(waFrom, `*${student.batches?.name ?? "Your batch"}*\n\n${gate.registered} students have registered so far.${minimumNote}`);
      return;
    }
    default: await sendWhatsAppText(waFrom, "I didn't recognize that option. Reply *Menu* to see the available actions."); return;
  }
}

export { handleMenuSelection };

async function sendAskInAppReply(waFrom: string): Promise<void> {
  // No link: questions live in the app, and signing in takes a code —
  // reply VERIFY here and the bot sends one. Text only, no URL: a link
  // would open in the browser instead of the installed app.
  await sendWhatsAppText(
    waFrom,
    "Please ask your questions inside the Student App. You will get your answer there, along with your batch, payment and petition details.\n\nOpen the Student App on your home screen and sign in there. If you need a code, reply *VERIFY* here and I'll send you a 6-digit code to type in the app.",
  );
}

export async function handleIncomingWhatsAppMessage(db: SupabaseClient, msg: ParsedWhatsAppMessage): Promise<void> {
  const phone = msg.from;
  const adminText = (msg.text ?? "").trim();

  // Always bootstrap the WhatsApp-admin table before classifying the sender.
  // Without this, a cold Vercel function could fail to recognize the configured
  // SUPER_ADMIN and fall through into the student flow, where LOGIN/app-login
  // could incorrectly produce a Student App registration link.
  await bootstrapAdmins(db);
  const admin = await getAdmin(db, phone);

  // LOGIN is reserved for the admin authentication flow. Never let an
  // unrecognized sender fall through to the student app-login flow.
  if (/^LOGIN$/i.test(adminText)) {
    if (!admin) {
      await sendWhatsAppText(msg.from, "This WhatsApp number is not authorized for Admin Panel login.");
      return;
    }
    try {
      const link = await generateAdminLoginLink(db, phone);
      await sendWhatsAppCtaButton(
        msg.from,
        "Secure one-time admin login link. It expires in 10 minutes and can be used once.",
        "Open Admin Panel",
        link,
        "Student Platform",
      );
    } catch (error) {
      console.error("[whatsapp/router] admin LOGIN failed", error);
      await sendWhatsAppText(msg.from, "Unable to generate the admin login link right now. Please try again.");
    }
    return;
  }

  // "VERIFY" means "let me into the app". The reply is a 6-digit login
  // code (see whatsapp/verify-code.ts) — the student's own message opens
  // the 24-hour WhatsApp window, so the code reply always arrives. It
  // sits before the bot's on/off switch and the admin branch on purpose:
  // signing in is authentication, not chat, and an admin needs it as much
  // as a student does.
  if (VERIFY_MESSAGE_RE.test(adminText)) {
    if (await replyWithCodeToVerify(db, msg.from, { isAdmin: !!admin })) return;
  }

  // Log every incoming text (even if blocked below) so the intent classifier
  // can be tested against real messages. Awaited, because serverless
  // functions can stop before a fire-and-forget write finishes.
  if (adminText) {
    const { logIncomingMessage } = await import("@/lib/whatsapp/message-log");
    const role: "admin" | "student" | "unknown" = admin
      ? "admin"
      : (await findStudentByPhone(db, phone).catch(() => null)) ? "student" : "unknown";
    await logIncomingMessage(db, phone, role, adminText);
  }

  // Safety gate: secret requests, database actions and prompt-injection
  // attempts get a fixed reply before any FAQ, AI or admin path runs. Applies
  // to students, admins and unknown senders alike. Logged, never forwarded.
  if (adminText && !msg.selectionId) {
    const { checkInboundRequest, BLOCKED_REPLY } = await import("@/lib/whatsapp/bot-guard");
    const blocked = checkInboundRequest(adminText);
    if (blocked) {
      console.warn("[whatsapp] blocked request", { category: blocked, role: admin ? "admin" : "other" });
      await sendWhatsAppText(msg.from, BLOCKED_REPLY[blocked]);
      return;
    }
  }

  if (admin) {
    if (msg.selectionId) { const handled = await handleAdminSelection(db, msg.from, msg.selectionId, (cmd) => handleAdminCommand(db, msg.from, cmd)); if (handled) return; }
    const adminMediaId = msg.imageId ?? msg.documentId ?? null;
    if (adminMediaId) { const { relayAdminMediaToStudent } = await import("@/lib/whatsapp/admin-photo-relay"); const relay = await relayAdminMediaToStudent(db, msg.from, msg.text, adminMediaId, msg.documentFilename); if (relay.handled) return; }
    const text = (msg.text ?? "").trim(); if (!text) { if (adminMediaId) await sendWhatsAppText(msg.from, `📷 To send this ${msg.imageId ? "photo" : "file"} to a student, resend it with the caption:\n\n*MESSAGE 9876543201 your message*`); return; }
    if (await handleAdminPhoneCapture(db, msg.from, text)) return;
    if (await answerAdminRegistrationStats(db, msg.from, phone, text)) return;
    // NOTE: `phone` is required here. Omitting it shifted every argument
    // along — `text` was read as the phone key and the literal "admin" as the
    // message — so isPaidCountQuestion("admin") was always false and an
    // admin asking "how many paid" silently fell through to the command
    // handler. tsc catches it; next.config's ignoreBuildErrors does not, so
    // it shipped.
    if (await answerPaidCount(db, msg.from, phone, text, "admin")) return;
    // The unpaid list ("List all the students who not paid...") is the
    // mirror of the paid count above — same admin branch, same position,
    // so it is answered from live data instead of falling through to the
    // grounded answer's "I don't have that information" (live 11 Nov 2026).
    if (await answerUnpaidList(db, msg.from, text)) return;
    if (await handleAdminCommand(db, msg.from, text)) return;
    // "App link" / "Link": send the Student App URL directly, before the AI.
    // The AI has no grounded app-link fact, so it wrote a "[link]"
    // placeholder (or "I'll send you the link") that the output guard
    // replaced with the "I couldn't finish that reply" fallback (live
    // 9 Nov 2026). Deterministic here — never reaches the AI.
    if (isAppLinkIntent(normaliseText(text).lower)) { await sendAppLink(db, msg.from, phone, "admin"); return; }
    // "Register": same direct-link pre-check as the student flow. The admin
    // tests the student experience from this number, and the AI has no
    // grounded answer for the bare command — it fell back to "I don't
    // know" (live 9 Nov 2026). The lookup finds no student profile for
    // the admin number, so this sends the new-student link: one tap
    // installs the app and lands straight on sign-up inside it.
    if (detectActionIntent(normaliseText(text).lower) === "register") {
      await setLastIntent(db, phone, "MENU_REQUEST").catch(() => {});
      await sendDirectAppLink(db, msg.from, phone);
      return;
    }
    // An admin typing "Hi" used to fall through to the AI, which greeted
    // with no name. Greet by name first, like every other sender — the
    // same question, name in front. Placed after handleAdminCommand on
    // purpose, so batch drafts and phone captures still win. "menu"/"help"
    // are commands, not greetings, so they still reach the command list.
    if (isWelcomeGreeting(text)) {
      const name = await resolveGreetingName(db, phone, msg.profileName);
      await sendWhatsAppText(msg.from, shortGreetingMessage(name));
      return;
    }
    // "Did she register?" after a shared number, and a bare number on its
    // own: neither is a command, so without this they fall through to the
    // STATUS_REQUEST classifier and come back as platform totals — the
    // the student-lookup regression. Runs after every typed
    // command on purpose, so MESSAGE / ANSWER / batch drafts still win.
    if (await answerStudentLookup(db, msg.from, text)) return;
    // Gateway-status questions ("Did cashfree pg is working") must be
    // answered from the live gateway switches — never by the LLM
    // classifier, which mapped "is working" to STATUS_REQUEST and came
    // back as platform totals (2026-10-27). Runs before the classifier
    // fallback on purpose.
    if (await answerGatewayStatusQuestion(db, msg.from, text, "admin")) return;
    const classifier = getIntentClassifier(); const result = await classifier.classify(text).catch(() => null); if (result && result.intent === "STATUS_REQUEST" && result.confidence >= CONFIDENCE_THRESHOLD) { await handleAdminCommand(db, msg.from, "STATUS"); return; }
    // NO raw searchFaq here. The FAQ corpus is written FOR STUDENTS, so
    // answering an admin from it verbatim is nonsense addressed to the wrong
    // person — the reported case was "Paid list" coming back as "check your
    // UPI app to confirm the amount was actually debited". Raising the
    // similarity threshold does NOT fix it: trigram similarity there was
    // 0.125, well under the 0.25 floor, so it was SEMANTIC search that
    // matched. The grounded answer below still receives the same FAQs as
    // knowledge, with audience:"admin", so it can use them as facts instead
    // of reciting them. (Removed once already; came back with the admin
    // handler.)
    const adminKnowledgeBase = await listFaqs(db).catch(() => []); const adminGrounded = await generateGroundedAnswer(text, {}, [], adminKnowledgeBase, "admin"); if (adminGrounded) { await sendWhatsAppText(msg.from, adminGrounded); return; }
    await handleAdminCommand(db, msg.from, "HELP"); return;
  }
  if (!(await isWhatsAppBotEnabled(db))) { console.info("[whatsapp/router] student message ignored (bot switched off)"); return; }
  // Secure callback from the college-search website. The raw token is kept server-side.
  // WhatsApp now receives only the selected college name.
  const incomingSelection = (msg.text ?? "").trim();
  const selectionMatch = incomingSelection.match(/^COLLEGE_SELECTED:([A-Za-z0-9_-]{20,80})$/);
  // A plain college name is only a selection when this WhatsApp number has a
  // matching unconsumed website-selection token. Never treat arbitrary text
  // such as "Hii" or "Register" as a college-selection callback.
  const pendingNameSelection = !selectionMatch && incomingSelection
    ? Boolean((await db.from("whatsapp_college_selection_tokens")
        .select("id")
        .eq("phone", normalizePhone(phone))
        .eq("college_name", incomingSelection)
        .is("consumed_at", null)
        .gt("expires_at", new Date().toISOString())
        .limit(1)
        .maybeSingle()).data)
    : false;
  if (selectionMatch || pendingNameSelection) {
    const selected = selectionMatch
      ? await consumeCollegeSelectionToken(db, phone, selectionMatch[1])
      : await consumeLatestCollegeSelection(db, phone, incomingSelection);
    if (!selected) { await sendWhatsAppText(msg.from, "That college-selection link has expired or is invalid. Please start the college search again."); return; }
    const colleges = await getActiveColleges(db);
    const supported = colleges.find(c => c.id === selected.collegeId || c.name.toLowerCase() === selected.collegeName.toLowerCase());
    if (supported) {
      const activeBatch = await getCurrentActiveBatch(db, supported.id).catch(() => null);
      const fee = activeBatch?.fee_amount != null ? Number(activeBatch.fee_amount) : null;
      if (activeBatch && (fee == null || fee <= 0)) {
        const adminPhones = await getActiveAdminPhones(db);
        await Promise.all(adminPhones.map(async (p: string) => {
          try {
            const { error } = await db.from("whatsapp_moderation").upsert({
              phone: normalizePhone(p),
              admin_batch_draft: { step: "set_fee", batchId: activeBatch.id, batchName: activeBatch.name },
              updated_at: new Date().toISOString(),
            }, { onConflict: "phone" });
            if (error) console.error("[whatsapp/router] active-batch fee prompt draft failed:", p, error);
          } catch (e) {
            console.error("[whatsapp/router] active-batch fee prompt draft failed:", p, e);
          }
        }));
      }
      if (activeBatch) {
      await notifySuperAdminOfRegistrationStart(db, supported.name, phone, activeBatch?.name ?? null, fee)
        .catch((error) => console.error("[whatsapp/router] super-admin registration notification failed", error));
      }
      await clearLastIntent(db, phone);
      await sendStudentAppLinkOrWaitlist(db, msg.from, phone, supported.id, supported.name);
      return;
    }
        // A valid token can only be issued for a college from the controlled
    // engineering-college directory. Never search the web or an external
    // entity database for a selected college.
    await clearLastIntent(db, phone);
    await sendWhatsAppText(
      msg.from,
      "That engineering college is no longer active in the Student Platform directory. Please start the college search again.",
    );
    return;
  }
  { const { data: closedProfileId } = await db.rpc("find_profile_by_normalized_phone", { p_phone: phone }); const decision = await closedBatchGate(db, closedProfileId as string | null, "whatsapp"); if (decision === "silence") return; if (decision === "notify") { await sendWhatsAppText(msg.from, closedBatchNotice()); return; } }
  if (msg.audioId && !msg.text) { const { transcribeVoiceNote, voiceFallbackMessage } = await import("@/lib/whatsapp/voice"); const result = await transcribeVoiceNote(msg.audioId); if (!result.text) { await sendWhatsAppText(msg.from, voiceFallbackMessage(result.error)); return; } msg = { ...msg, text: result.text }; }
  if (msg.imageId) {
    const handled = await handleIncomingIdReuploadImage(db, msg.from, phone, msg.imageId);
    if (handled) return;

    // Contact Support owns an incoming photo too. Do this BEFORE the generic
    // image handler so a screenshot becomes a real support request instead of
    // merely getting a generic "I can see this" description.
    if (await consumeAwaitingSupportMessage(db, phone)) {
      const incoming = await analyzeIncomingImageWithUrl(msg.imageId).catch((e) => {
        console.error("[whatsapp/router] support image analysis failed", e);
        return null;
      });
      const caption = (msg.text ?? "").trim();
      if (incoming) {
        await handleWhatsAppSupportMessage(db, msg.from, phone, caption, {
          url: incoming.url,
          description: incoming.analysis?.description ?? null,
        });
      } else {
        await handleWhatsAppSupportMessage(db, msg.from, phone, caption);
      }
      return;
    }

    // No active support flow was expecting this photo. Analyze it and continue
    // with the normal conversational pipeline instead of discarding it.
    const analysis = await analyzeIncomingImage(msg.imageId).catch((e) => {
      console.error("[whatsapp/router] image analysis failed", e);
      return null;
    });
    if (analysis) {
      const caption = (msg.text ?? "").trim();
      if (!caption) {
        await sendWhatsAppText(msg.from, `📸 I can see this — ${analysis.description}\n\nReply with your question if you'd like help with it, or *Menu* for other options.`);
        return;
      }
      msg = { ...msg, text: `${caption}\n\n(Attached photo — I can see: ${analysis.description})` };
    }
  }
  if (msg.selectionId) { await handleMenuSelection(db, msg.from, phone, msg.selectionId, msg.profileName); return; }
  const text = (msg.text ?? "").trim(); const lower = text.toLowerCase(); if (!text) { await showMenu(msg.from); return; }
  // "Register" / "App link" — deterministic commands. Checked HERE (before
  // college-search, support, and moderation) because a bare command word
  // must never be diverted by conversation state. Before this fix the
  // only register check lived inside the "genuine" moderation case, so a
  // new number got the name prompt ("ask_name") and a number with a stale
  // COLLEGE_SEARCH intent got the college-search reply — both bypassed
  // the pre-check and fell through to the AI, which answered "I don't
  // know this one yet" (live 9 Nov 2026). Now every student message that
  // is a register/app-link command sends the direct one-tap link here,
  // and a send failure falls back to a plain-text link instead of the AI.
  if (detectActionIntent(normaliseText(text).lower) === "register") {
    await setLastIntent(db, phone, "MENU_REQUEST").catch(() => {});
    try {
      await sendDirectAppLink(db, msg.from, phone);
    } catch (e) {
      console.error("[whatsapp/router] sendDirectAppLink failed, sending plain link", e);
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev";
      await sendWhatsAppText(msg.from, `Here's the Student App — one tap installs it, then sign up inside the app.\n\n${appUrl}/install?next=/signup`);
    }
    return;
  }
  if (isAppLinkIntent(normaliseText(text).lower)) { await sendAppLink(db, msg.from, phone, "student"); return; }
  if (/^(what(?: is|s) this|what is student support|about|how does this work|what do you do|what is this bot)\??$/.test(lower.trim())) { const name = await resolveGreetingName(db, phone, msg.profileName); await sendProcessExplanationWithCta(db, msg.from, name); await markProcessExplained(db, phone); return; }
  // College search owns the next message after "My college is not listed" or a
  // large-college-list prompt. This must run before Contact Support: the old
  // implementation stored both states and the generic support consumer captured
  // the college name, creating a misleading "New Student Question" (UQ-xxx)
  // notification instead of the dedicated college-review notification.
  {
    const row = await db.from("whatsapp_moderation")
      .select("last_intent, last_intent_at")
      .eq("phone", normalizePhone(phone))
      .maybeSingle()
      .then(r => r.data);
    const recentCollegeSearch =
      row?.last_intent === "COLLEGE_SEARCH" &&
      !!row.last_intent_at &&
      Date.now() - new Date(row.last_intent_at).getTime() >= 0 &&
      Date.now() - new Date(row.last_intent_at).getTime() <= 30 * 60 * 1000;
    if (recentCollegeSearch) {
      // Do NOT clear COLLEGE_SEARCH before handling the message. If the first
      // search has no local/online match, the student must be able to try a
      // corrected spelling in the next message. The old code cleared the state
      // first, so a sequence such as "Cc v" -> "Snsit" left the second search
      // to the generic NLP/greeting path.
      await handleCollegeSearchReply(db, msg.from, phone, text);
      return;
    }
  }
  // Contact Support owns the next message, regardless of its wording.
  // Keep a small phrase-based fallback too: if the support-state write failed
  // (for example during a migration/deployment mismatch), a generic reply such
  // as "I want to talk" must never be sent to college search or FAQ matching.
  if (await consumeAwaitingSupportMessage(db, phone) ||
      /^(?:i\s+want\s+to\s+talk|i\s+wanna\s+talk|talk\s+to\s+(?:support|someone)|speak\s+to\s+(?:support|someone)|contact\s+support|need\s+to\s+talk(?:\s+to\s+(?:support|someone))?)(?:\s+please)?[.!?]*$/i.test(text)) {
    await handleWhatsAppSupportMessage(db, msg.from, phone, text);
    return;
  }
  // Fetched once here and threaded through to handleFreeTextQuestion's
  // "genuine" case below, instead of that function re-running the identical
  // findStudentByPhone lookup a second time for the same message.
  const studentForCount = await findStudentByPhone(db, phone).catch(() => null);
  if (await answerPaidCount(db, msg.from, phone, text, "student", studentForCount?.batch_id ?? null)) return;
  if (await answerPersonalPaymentStatus(db, msg.from, phone, text)) return;
  {
    const colleges = await getActiveColleges(db);
    const matchedCollege = colleges.find(c => c.id.toLowerCase() === lower || c.name.toLowerCase() === lower);
    if (matchedCollege) {
      const priorTurns = await getRecentTurns(db, phone).catch(() => []);
      const lastBotTurn = [...priorTurns].reverse().find(t => t.role === "assistant");
      if (lastBotTurn && isFeeClarifyingReply(lastBotTurn.content)) {
        // Rule 8: the bot must NEVER quote a
        // fee amount, even one already set on the batch record. The fee is
        // only finalised once the batch reaches its minimum number of
        // registered students, at which point the ADMIN announces it in the
        // Student App — WhatsApp is not the channel for the number.
        const out = `The ${matchedCollege.name} registration fee will be finalised once enough students have registered for the batch — the admin will announce the exact amount in the Student App at that point. Reply *Register* to join now.`;
        await sendWhatsAppText(msg.from, out); await recordTurn(db, phone, "user", text).catch(() => {}); await recordTurn(db, phone, "bot", out).catch(() => {}); return;
      }
      await handleMenuSelection(db, msg.from, phone, `college_${matchedCollege.id}`); return;
    }
  }
  if (lower === "verify") { const { requestAppLoginOtp } = await import("@/lib/app-login"); const result = await requestAppLoginOtp(db, phone); if (!result.ok) await sendWhatsAppText(msg.from, result.error); return; }
  if (isIdReuploadTrigger(text)) { await startIdReuploadFlow(db, msg.from, phone); return; }
  // Reply to the diagnose "which screen are you stuck on?" question: the
  // pending slot is waiting for it, so it goes straight to the diagnosis
  // instead of through moderation / the AI brain (a bare "login" or "2"
  // would otherwise be misread). The handler clears the slot itself.
  {
    const appPending = await loadPending(db, phone, "app_problem").catch(() => null);
    if (appPending) {
      const label = await handleAppProblem(db, msg.from, phone, text);
      await recordTurn(db, phone, "user", text).catch(() => {});
      await recordTurn(db, phone, "bot", label).catch(() => {});
      return;
    }
  }
  const verdict = await moderateIncomingText(db, phone, text);
  switch (verdict.kind) {
    case "ask_name": { const name = await resolveGreetingName(db, phone, msg.profileName); await sendWhatsAppText(msg.from, askNameMessage(name)); return; }
    case "name_collected": { await sendProcessExplanationWithCta(db, msg.from, verdict.name); await markProcessExplained(db, phone); return; }
    case "blocked_permanent": await sendWhatsAppText(msg.from, "Your access to this support line has been restricted pending admin review. Please contact the college office directly if this is urgent."); return;
    case "blocked_temp": { const until = new Date(verdict.until).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); await sendWhatsAppText(msg.from, `You're temporarily restricted from using this support line until ${until}, due to repeated unrelated/spam messages. Contact the college office directly if this is urgent.`); return; }
    case "greeting_open": {
      if (isExplicitMenuRequest(lower)) { await showMenu(msg.from); await sendFixGuidePhoto(msg.from); await showFixOptions(msg.from); return; }
      const name = await resolveGreetingName(db, phone, msg.profileName);
      if (!(await hasHadProcessExplanation(db, phone))) { await sendProcessExplanationWithCta(db, msg.from, name); await markProcessExplained(db, phone); return; }
      // A returning student who types "Hi" should still get the tappable
      // options. The old plain-text reply made the bot look conversational but
      // left the student with no clear next action — and was exactly what the
      // live test was showing after the welcome had already been marked seen.
      await showMenu(msg.from, name); return;
    }
    case "greeting_close": { const name = await resolveGreetingName(db, phone, msg.profileName); await sendWhatsAppText(msg.from, name ? `You're welcome, ${name}! Reply *menu* anytime you need help. 🙂` : "You're welcome! Reply *menu* anytime you need help. 🙂"); return; }
    case "spam_notice_1": { const who = verdict.name ? `${verdict.name}, ` : ""; await sendWhatsAppText(msg.from, `${who}I'm designed only for student services such as registration, payments, petition status, certificates, and announcements.\n\nPlease ask a student-related question or tap Menu.`); return; }
    case "spam_notice_2": { const who = verdict.name ? `${verdict.name}, ` : ""; await sendWhatsAppText(msg.from, `${who}this conversation appears unrelated to student services.\n\nPlease keep this chat focused on official student support. Continued misuse may result in temporary restrictions.`); return; }
    case "spam_final_warning": { const who = verdict.name ? `${verdict.name}, ` : ""; await sendWhatsAppText(msg.from, `${who}this is your final warning.\n\nRepeated non-student conversations interfere with support for other students.\n\nIf another unrelated message is received, your access will be temporarily restricted.`); return; }
    case "spam_muted": { const who = verdict.name ? `${verdict.name}, ` : ""; await sendWhatsAppText(msg.from, `${who}your access has been temporarily restricted (${verdict.label}) for repeated misuse of the support bot.\n\nIf you need genuine student support later, you can contact an administrator or wait until the restriction expires.`); await notifyAdminOfMute(phone, verdict.name, 4, verdict.label); return; }
    case "spam_flagged_for_review": { const who = verdict.name ? `${verdict.name}, ` : ""; await sendWhatsAppText(msg.from, `${who}this number has already been restricted multiple times for repeated misuse. An admin has been notified to review your access.\n\nPlease contact the college office directly if you need genuine student support.`); return; }
    case "genuine": {
      // "Stuck? Fix it in 2 minutes" — a student reporting one of the three
      // guide problems gets the photo + short fix straight away, no AI round
      // trip and no extra questions. One photo per report; the bot never
      // re-sends it unprompted, so it cannot loop.
      const fixProblem = matchFixProblem(text);
      if (fixProblem) {
        await sendFixFor(msg.from, fixProblem);
        await recordTurn(db, phone, "user", text).catch(() => {});
        await recordTurn(db, phone, "bot", `fix-guide:${fixProblem}`).catch(() => {});
        return;
      }
      // "App not working" in any wording — diagnosed from the student's
      // own record (profile, payment, recent phone errors, known server
      // breakage) with a one-tap fix, or a ticket filed for them. This
      // runs BEFORE the AI brain on purpose: the AI is down, and a generic
      // report used to fall through to "ask inside the Student App".
      if (matchAppProblem(text)) {
        const label = await handleAppProblem(db, msg.from, phone, text);
        await recordTurn(db, phone, "user", text).catch(() => {});
        await recordTurn(db, phone, "bot", label).catch(() => {});
        return;
      }
      // Gateway-status questions get a deterministic answer from the live
      // switches before the AI path — the FAQ corpus has no row about
      // which gateway is live, so the model answered from the nearest
      // payment FAQ instead (2026-10-27).
      if (await answerGatewayStatusQuestion(db, msg.from, text, "student")) return;
      // "App link" / "Link": send the Student App URL directly, before the
      // AI. Same reason as the admin branch — the AI wrote a "[link]"
      // placeholder the output guard replaced with the fallback.
      if (isAppLinkIntent(normaliseText(text).lower)) { await sendAppLink(db, msg.from, phone, "student"); return; }
      // "Register" / "I need to register": fetch who is asking and send
      // them the direct app/registration link — before the AI. The AI has
      // no grounded answer for a bare command word, so it escalated to the
      // "I don't know" fallback and the keyword router (which knows
      // "register") never ran (live 9 Nov 2026). Same pattern as the
      // "App link" bypass above.
      if (detectActionIntent(normaliseText(text).lower) === "register") {
        await setLastIntent(db, phone, "MENU_REQUEST").catch(() => {});
        await sendDirectAppLink(db, msg.from, phone);
        return;
      }
      // AI understands first (item #221): the model reads the message with
      // this student's real data and answers or runs the right action.
      if (await answerWithAiFirst(db, msg.from, phone, text, studentForCount)) return;
      // Every AI provider is down → the old keyword routing, unchanged.
      const fallbackLower = normaliseText(text).lower;
      if (detectActionIntent(fallbackLower) === "app_link") {
        await sendAppLink(db, msg.from, phone, "student");
        return;
      }
      if (detectActionIntent(fallbackLower) === "app_login") {
        // Same as VERIFY: a login code on WhatsApp, never a link.
        await replyWithCodeToVerify(db, msg.from, { isAdmin: !!admin });
        return;
      }
      if (detectActionIntent(fallbackLower)) { await handleFreeTextQuestion(db, msg.from, phone, text, studentForCount); return; }
      await sendAskInAppReply(msg.from);
      return;
    }
  }
}

