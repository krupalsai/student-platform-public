import type { SupabaseClient } from "@supabase/supabase-js";
import { buildStudentSnapshot, snapshotToFacts, describePayment, describeBatch, caseOutcomeLine, caseStatusText, isBatchOver, type StudentSnapshot } from "@/lib/services/student-snapshot";
import { OUTCOME_QUESTION, unsupportedOutcomeClaim } from "@/lib/case-outcome-guard";
import { isPetitionMinimumWorthStating } from "@/lib/services/payment-gate";
import { recordUnknownQuestion, saveDraftFaq } from "@/lib/services/faq";
import { retrieveRelevantFaqs } from "@/lib/services/faq-retrieval";
import { inAppShortReply, completeSupportReply } from "@/lib/services/support-response-guard";
import { looksLikeRealQuestion } from "@/lib/whatsapp/rule-intent";
import { generateGroundedAnswerDetailed } from "@/lib/intent-engine";
import { notifyAdminWhatsApp } from "@/lib/whatsapp/admin";
import { notifyAdminOfNewDraftFaq } from "@/lib/whatsapp/draft-faqs";
import type { ChatTurn } from "@/lib/intent-engine/groq-provider";
import { asMenuTopic, type SupportMenuTopic } from "@/lib/support-menu";

/**
 * The in-app Student Platform assistant. Every student message in the
 * Contact Support thread gets a reply in the SAME request, built in this
 * order — cheapest and most authoritative first:
 *
 *   1. deterministicReply — menu taps, greetings and exact one-liners
 *      ("payment status") answered from the student's own data, no model
 *      call. Everything else is understood by the model first (item #221);
 *      the canned one-word pointers (inAppShortReply) only run when every
 *      provider is down.
 *   2. the grounded model (Gemini → Groq → OpenRouter) given the student's
 *      full snapshot as STUDENT CONTEXT plus the relevant FAQs and the last
 *      10 turns, so it can understand natural/mixed-language phrasing and
 *      reason across registration → payment → batch. It may attach one
 *      in-app button ([[OPEN:x]], validated against ACTIONS).
 *   3. if every provider is DOWN: the relevant fact plus "try again" — an
 *      outage never files a support case.
 *   4. if a provider answered and genuinely doesn't know: the question goes
 *      to the team (recordUnknownQuestion + WhatsApp alert) and the route
 *      marks the thread pending_admin; the admin's reply (from
 *      /admin/support, WhatsApp ANSWER, or /admin/questions) lands back in
 *      this same thread.
 *
 * The AI boundary rules are unchanged: it explains and points, it never
 * approves, edits or claims to have done anything.
 */

export interface SupportAction {
  label: string;
  href: string;
}

export interface SupportBotReply {
  reply: string;
  escalated: boolean;
  /** One in-app destination button, already validated against ACTIONS. */
  action?: SupportAction | null;
  /** True when every AI provider was down — the UI offers "Try again". */
  retryable?: boolean;
  provider?: string;
  /** Set on escalation; the route links the thread to it for answer delivery. */
  unknownQuestionId?: string | null;
}

/** The ONLY destinations a reply may link to. Anything else the model emits is dropped. */
export const ACTIONS: Record<string, SupportAction> = {
  payments: { label: "Open Payments", href: "/payments" },
  batch: { label: "Open Batch", href: "/batch" },
  messages: { label: "Open Messages", href: "/messages" },
  profile: { label: "Open Profile", href: "/profile" },
  correction: { label: "Correct my details", href: "/correction" },
  register: { label: "Continue registration", href: "/register" },
  discussion: { label: "Open Batch Discussion", href: "/discussion" },
};

/** Home holds the court case card (tracker, orders, live updates). Not a model-selectable [[OPEN:]] value. */
const HOME_ACTION: SupportAction = { label: "Open Home", href: "/dashboard" };

const ACTION_TAG = /\[\[\s*OPEN\s*:\s*([^\]]*?)\s*\]\]/gi;

/** Strips every [[OPEN:x]] tag and returns the first valid one as a button. */
export function extractAction(text: string): { text: string; action: SupportAction | null } {
  let action: SupportAction | null = null;
  const clean = text.replace(ACTION_TAG, (_m, key: string) => {
    const k = key.trim().toLowerCase();
    if (!action && Object.prototype.hasOwnProperty.call(ACTIONS, k)) action = ACTIONS[k];
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean, action };
}

function bareDescriptionReply(photoDescription: string | null | undefined): SupportBotReply {
  const reply = photoDescription
    ? `I can see this — ${photoDescription}\n\nThis is what the photo shows, not a confirmation from our records. What would you like to know about it?`
    : "I received the photo, but couldn't automatically read it. Could you tell me what it's about or what you need help with?";
  return { reply, escalated: false };
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");
}

/**
 * Answers that come straight from the student's own data, with no model call.
 * Deliberately narrow — only messages whose meaning is unambiguous on their
 * own. Anything phrased naturally ("I paid yesterday why still pending",
 * "payment ayinda?") goes to the model WITH this same data, which is what
 * lets it understand intent rather than match keywords.
 */
/**
 * Answers for the Support menu buttons (support-menu.ts). Pure data, no
 * model: every answer is built from the student's own snapshot, so it is
 * instant, free and never needs an admin.
 */
export function menuReply(topic: SupportMenuTopic, s: StudentSnapshot): SupportBotReply {
  switch (topic) {
    case "Payment status":
      return { reply: describePayment(s), escalated: false, action: ACTIONS.payments };
    case "Fee & how to pay": {
      const g = s.gate;
      if (s.payment.state === "approved") return { reply: describePayment(s), escalated: false, action: ACTIONS.payments };
      // A closed batch can't be paid into, and its current fee is not what the
      // students in it paid — quoting it only confuses (real thread, 2026-10-08).
      if (isBatchOver(s)) return { reply: `Your batch is ${s.batch!.status}, so payment is no longer open.`, escalated: false, action: ACTIONS.payments };
      if (g?.fee == null) {
        return { reply: "The fee for your batch hasn't been announced yet. It appears on your Payments tab as soon as the admin sets it — nothing to pay until then.", escalated: false, action: ACTIONS.payments };
      }
      return {
        reply: g.open
          ? `The fee for your batch is ₹${g.fee}. Open the Payments tab and tap Pay — UPI, card or net banking. It is confirmed automatically, no screenshot needed.`
          : `The fee for your batch is ₹${g.fee}. ${g.message ?? "Payment isn't open yet."}`,
        escalated: false,
        action: ACTIONS.payments,
      };
    }
    case "My batch & seats":
      return { reply: describeBatch(s) + (s.gate && s.batch?.status === "active" && isPetitionMinimumWorthStating(s.gate.required) ? ` The petition needs at least ${s.gate.required}.` : ""), escalated: false, action: ACTIONS.batch };
    case "Court case status":
      return { reply: caseStatusText(s.caseInfo), escalated: false, action: s.caseInfo ? HOME_ACTION : null };
    case "Certificate steps":
      return {
        reply: s.payment.state === "approved"
          ? `The step-by-step route to collect your certificates is the Route Map on the Batch tab.${s.representative ? ` Your batch representative for the Court Order copy is ${s.representative.name}.` : ""}`
          : "The certificate Route Map unlocks once your payment is approved.",
        escalated: false,
        action: ACTIONS.batch,
      };
    case "Correct my details":
      return {
        reply: s.batch?.status === "closed"
          ? "Your batch has been closed, so details can no longer be changed in the app."
          : "You can fix your name, father's name, address and re-upload your College ID from the Correction screen. Roll number, branch, year and college are locked once registered.",
        escalated: false,
        action: s.batch?.status === "closed" ? null : ACTIONS.correction,
      };
    case "College ID / documents":
      if (!s.documents.collegeIdUploaded) {
        return { reply: "Your College ID photo hasn't been uploaded yet. Upload it while finishing registration.", escalated: false, action: ACTIONS.register };
      }
      if (s.documents.aiFlag) {
        return {
          reply: `Your College ID is uploaded, but the automatic check found that ${s.documents.aiFlag}. ${s.documents.reuploadUsed ? "Your one-time re-upload has already been used." : "You can re-upload it once from the Correction screen."}`,
          escalated: false,
          action: s.documents.reuploadUsed ? null : ACTIONS.correction,
        };
      }
      return { reply: "Your College ID photo is uploaded and nothing is flagged on it.", escalated: false };
    case "Registration status":
      return s.registrationComplete
        ? { reply: `Your registration is complete${s.batch ? ` and you're in ${s.batch.name}` : ""}.`, escalated: false }
        : { reply: "Your registration isn't complete yet. Finish the form to join your batch.", escalated: false, action: ACTIONS.register };
    case "Stuck? Fix it in 2 minutes":
      return {
        reply: "Stuck? Open the “Stuck? Fix it in 2 minutes” photo at the top of this Support page — it has all 3 fixes. In short: if your OTP isn't coming, message VERIFY to the WhatsApp bot and type the 6-digit code it replies with into the Student App; if your number isn't registered, tap “Register on WhatsApp” on the login page; if it's still stuck, clear site data (long-press the app icon → Site settings → Delete data) and log in again.",
        escalated: false,
      };
  }
}

/**
 * A model reply that claims how the case went (or what the court directed) when
 * the court's record does not say so becomes the record's own answer instead.
 * Returns null when the reply is fine.
 */
export function outcomeGuardedReply(reply: string, s: StudentSnapshot): SupportBotReply | null {
  if (!unsupportedOutcomeClaim(reply, s.caseInfo)) return null;
  return { reply: caseStatusText(s.caseInfo), escalated: false, action: s.caseInfo ? HOME_ACTION : null };
}

const CHASING = /\b(any (update|news|reply|response|answer)|update|previous question|earlier question|got (any|a) (reply|response|answer)|did (you|they) (reply|respond|answer)|heard back|still waiting|waiting for|raise (this|these|it)|owner)\b/;

const WAITING_ON_TEAM_REPLY = "Your question is with the support team and they haven't replied yet. It's still open, and their answer will appear right here in this chat with a notification. If something else comes up, ask me anyway — I can check your own account details straight away.";

const HUMAN_VERB = /\b(contact|call|connect|talk|speak|reach|raise|escalate|forward|pass|transfer|refer|chat)\b/;
const HUMAN_NOUN = /\b(support|team|admins?|human|owner|staff|agent|representative|someone|somebody|person)\b/;
const HUMAN_DIRECT = /\b(human|real person|live agent|customer care|customer support|support team|support person|owner of (this|the) app)\b/;
/** "How do I contact support?" asks HOW — the assistant answers that, it doesn't escalate it. */
const INFO_QUESTION = /^(how|where|what|which|when|who|whom|why|is|are|will|does|do|did|can you tell|tell me how)\b/;

/**
 * An explicit request for a person: "contact support team", "raise this to the
 * owner", "talk to someone". Real threads showed the assistant answering such
 * a request with "what specifically do you need help with?" — twice. Short
 * messages only (a long story that mentions the team in passing goes to the
 * model), and never a "how do I…" question.
 */
export function wantsHuman(caption: string): boolean {
  const q = norm(caption);
  if (!q || q.length > 120 || INFO_QUESTION.test(q)) return false;
  return HUMAN_DIRECT.test(q) || (HUMAN_VERB.test(q) && HUMAN_NOUN.test(q));
}

const ORDER_COPY = /\b(soft\s*-?\s*copy|softcopy|order copy|copy of (the )?(order|case|judg(?:e)?ments?|court)|judg(?:e)?ments?|final order|court order|disposed|verdict)\b/;

export function deterministicReply(caption: string, s: StudentSnapshot): SupportBotReply | null {
  const topic = asMenuTopic(caption);
  if (topic) return menuReply(topic, s);
  const q = norm(caption);
  if (/^(hi+|hello+|hey+|hai|namaste|good (morning|afternoon|evening))$/.test(q)) {
    const first = s.name?.split(" ")[0];
    return { reply: `Hi${first ? ` ${first}` : ""}! Ask me anything about your registration, payment, batch, documents or case — in your own words.`, escalated: false };
  }
  if (/^(thanks?|thank you|thanku|tq|ok|okay|k|fine|got it)$/.test(q)) {
    return { reply: "You're welcome. Ask me anytime if something else comes up.", escalated: false };
  }
  // Final order / soft copy of a DISPOSED case: always the same factual answer.
  // Left to the model, it copied its own earlier wrong reply ("Messages tab")
  // out of the chat history again and again (item #235).
  if (s.caseInfo?.disposedOn && ORDER_COPY.test(q)) {
    return { reply: caseOutcomeLine(s.caseInfo), escalated: false, action: HOME_ACTION };
  }
  // "Did we win?", "what did the court say?", "case result": how the case went is
  // answered from the court's record only. A model asked this has claimed a
  // disposal "in your favour" for a case with no number on file (2026-10-08), and
  // "DISPOSED OF NO COSTS" does not say who won.
  if (OUTCOME_QUESTION.test(q)) {
    return { reply: caseStatusText(s.caseInfo), escalated: false, action: s.caseInfo ? HOME_ACTION : null };
  }
  if (/^(payment|payments|payment status|my payment|my payment status|status|my status)$/.test(q)) {
    return { reply: describePayment(s), escalated: false, action: ACTIONS.payments };
  }
  if (/^(batch|my batch|batch status|which batch)$/.test(q)) {
    return { reply: describeBatch(s), escalated: false, action: ACTIONS.batch };
  }
  if (/^(fee|fees|my fee|fee amount)$/.test(q)) {
    const g = s.gate;
    if (s.payment.state === "approved") return { reply: describePayment(s), escalated: false, action: ACTIONS.payments };
    if (isBatchOver(s)) return { reply: `Your batch is ${s.batch!.status}, so payment is no longer open.`, escalated: false, action: ACTIONS.payments };
    const reply = g?.fee != null
      ? `The fee for your batch is ₹${g.fee}. ${g.open ? "Payment is open on the Payments tab." : g.message ?? "Payment isn't open right now."}`
      : g?.message ?? "The fee for your batch hasn't been set yet. It will appear on your Payments tab once the admin sets it.";
    return { reply, escalated: false, action: ACTIONS.payments };
  }
  if (/^(registration|registration status|my registration|am i registered)$/.test(q)) {
    return s.registrationComplete
      ? { reply: `Your registration is complete${s.batch ? ` and you're in ${s.batch.name}` : ""}.`, escalated: false }
      : { reply: "Your registration isn't complete yet. Finish the form to join your batch.", escalated: false, action: ACTIONS.register };
  }
  return null;
}

const PRIVATE_TOPIC = "(?:payment|payments|status|batch|fee|fees|registration|details|data|phone|number|roll number|marks|documents?|id card|profile)";
/** Possessive name before a private topic: "Rahul's payment", "rahul’s status". Apostrophe required. */
const POSSESSIVE = new RegExp(`\\b([a-z]{3,})['’]s\\s+${PRIVATE_TOPIC}\\b`, "i");
/** Private topic "of/for" a name: "payment status of Rahul", "details for priya". */
const OF_NAME = new RegExp(`\\b${PRIVATE_TOPIC}\\s+(?:of|for)\\s+([a-z]{3,})\\b`, "i");
const THIRD_PARTY = /\b(my friend|my classmate|my roommate|my brother|my sister|other student|another student|someone else|somebody else|all students|every student|other students|everyone(?:'s)? (?:payment|details|status))\b/i;
const NOT_A_NAME = new Set([
  "what", "that", "this", "his", "her", "their", "its", "everyone", "today", "today", "batch", "college", "student", "students",
  "admin", "team", "registration", "payment", "court", "case", "petition", "fee", "fees", "me", "my", "mine", "you", "your",
  "gnit", "gnitc", "biet", "all", "each", "the", "next", "last", "previous", "current", "month", "year", "semester",
]);

/**
 * Deterministic privacy guard, BEFORE any model runs. The model only ever
 * receives the asking student's own data, so nothing about another student
 * can leak — but a small model (seen with the self-hosted qwen2.5:0.5b) will
 * answer "Rahul's payment status" with the ASKER's own details, which is
 * false. This refuses those questions whatever provider is behind the
 * assistant. Deliberately narrow (an apostrophe possessive or "of/for
 * <name>" next to a private topic, or an explicit third party) so ordinary
 * questions are never refused; anything it misses still meets the prompt's
 * own-account-only rule.
 */
export function aboutAnotherStudent(caption: string, s: StudentSnapshot): boolean {
  if (THIRD_PARTY.test(caption)) return true;
  const own = new Set((s.name ?? "").toLowerCase().split(/\s+/).filter(Boolean));
  for (const re of [POSSESSIVE, OF_NAME]) {
    const who = caption.match(re)?.[1]?.toLowerCase();
    if (who && !NOT_A_NAME.has(who) && !own.has(who)) return true;
  }
  return false;
}

/** A question about the student's OWN state must never become a public FAQ draft. */
function isPersonal(question: string, answer: string, s: StudentSnapshot): boolean {
  if (/\b(my|me|mine|i|im|i'm|naa|na|nenu|naaku|maa)\b/i.test(question)) return true;
  if (s.name && answer.toLowerCase().includes(s.name.toLowerCase().split(" ")[0])) return true;
  return /₹|\byour (payment|batch|registration|fee)\b/i.test(answer);
}

function relevantFact(question: string, s: StudentSnapshot): string {
  const q = question.toLowerCase();
  if (/pa(y|id)|money|amount|dabbu|paisa|verify|verif/.test(q)) return describePayment(s) + " ";
  if (/batch/.test(q)) return describeBatch(s) + " ";
  return "";
}

/** Records the question for the team and alerts the admins (new questions only). */
async function fileForTeam(db: SupabaseClient, studentId: string, snapshot: StudentSnapshot, message: string) {
  const profilePhone = await db.from("profiles").select("phone").eq("id", studentId).maybeSingle()
    .then((r) => (r.data as any)?.phone ?? null, () => null);
  const result = await recordUnknownQuestion(db, message, {
    phone: profilePhone ?? undefined,
    college: snapshot.college ?? undefined,
  });
  if (result.isNew && !result.saveFailed) {
    const { data: uq } = await db.from("unknown_questions").select("short_id").eq("id", result.id).maybeSingle();
    await notifyAdminWhatsApp(
      db, result.id, uq?.short_id ?? null, `[Student App] ${message}`, profilePhone ?? "unknown", result.occurrenceCount,
    ).catch((e) => console.error("[support-bot] notifyAdminWhatsApp failed", e));
  }
  return result;
}

export async function generateSupportBotReply(
  db: SupabaseClient,
  studentId: string,
  input: { caption: string; photoDescription?: string | null; waitingOnTeam?: boolean },
  priorHistory: ChatTurn[],
): Promise<SupportBotReply> {
  const caption = input.caption.trim();
  if (!caption) return bareDescriptionReply(input.photoDescription);

  const snapshot = await buildStudentSnapshot(db, studentId);

  // 0. Never discuss another student's account.
  if (aboutAnotherStudent(caption, snapshot)) {
    return {
      reply: "I can only help with your own account, so I can't share or check anyone else's details. If they need help, they can ask here from their own login.",
      escalated: false,
    };
  }

  // 0b. The student is chasing a question the team has not answered yet
  //     ("any update?", "do you get any about my previous question"): say so
  //     plainly instead of asking the model, which just re-escalates.
  if (input.waitingOnTeam && CHASING.test(norm(caption))) {
    return { reply: WAITING_ON_TEAM_REPLY, escalated: false };
  }

  // 0c. An explicit request for a person is honoured directly, with the
  //     student's recent messages attached so the team knows what it is about.
  if (wantsHuman(caption)) {
    if (input.waitingOnTeam) return { reply: WAITING_ON_TEAM_REPLY, escalated: false };
    const earlier = priorHistory.filter((t) => t.role === "user").slice(-2).map((t) => `"${t.content.trim().slice(0, 160)}"`).filter((t) => t.length > 2);
    const handoff = `[Student asked for the support team] ${caption}${earlier.length ? `\nEarlier messages: ${earlier.join(" / ")}` : ""}`;
    console.info("[support-bot] reply", { path: "explicit_handoff" });
    const filed = await fileForTeam(db, studentId, snapshot, handoff);
    if (filed.saveFailed) {
      return { reply: "I couldn't reach the support team just now. Please try again in a minute.", escalated: false, retryable: true };
    }
    return {
      reply: "Done — I've sent this to the support team along with your recent messages. Their reply will appear right here in this chat, and you'll get a notification.",
      escalated: true,
      unknownQuestionId: filed.id,
    };
  }

  // 1. Deterministic, data-only answers — no model, no cost, no guessing.
  const direct = deterministicReply(caption, snapshot);
  if (direct) return direct;
  const message = input.photoDescription
    ? `${caption}\n\n(Attached photo — I can see: ${input.photoDescription}. This describes the image only; it is not verified against our records.)`
    : caption;

  // 2. The model, with the student's real data and the relevant FAQs.
  const retrieval = await retrieveRelevantFaqs(db, caption, priorHistory);
  const knowledgeBase = retrieval.faqs;
  const outcome = await generateGroundedAnswerDetailed(
    message,
    {
      name: snapshot.name,
      college: snapshot.college,
      batch: snapshot.batch?.name ?? null,
      registrationComplete: snapshot.registrationComplete,
      facts: snapshotToFacts(snapshot),
    },
    priorHistory,
    knowledgeBase,
    "student",
    "app",
  );

  if (outcome.kind === "answer") {
    console.info("[support-bot] reply", { path: "ai", provider: outcome.provider, retrieval: retrieval.method, faqCount: knowledgeBase.length });
    const { text, action } = extractAction(outcome.text);
    const reply = completeSupportReply(text);
    // Last line of defence: no win, loss or court direction the record doesn't show.
    const guarded = outcomeGuardedReply(reply, snapshot);
    if (guarded) {
      console.warn("[support-bot] reply claimed a case outcome the court record does not show — replaced", { provider: outcome.provider });
      return { ...guarded, provider: outcome.provider };
    }
    if (looksLikeRealQuestion(caption) && !isPersonal(caption, reply, snapshot)) {
      saveDraftFaq(db, caption, reply)
        .then((id) => { if (id) notifyAdminOfNewDraftFaq(db, id, caption, reply); })
        .catch((e) => console.error("[support-bot] saveDraftFaq failed", e));
    }
    return { reply, escalated: false, action, provider: outcome.provider };
  }

  // 3a. Every provider down: this is an outage, not an unanswerable question.
  //     Give what the data says and let the student retry — no support case.
  if (outcome.kind === "unavailable") {
    console.warn("[support-bot] reply", { path: "all_providers_down" });
    // AI understands first (item #221); the canned one-word pointers are only
    // a fallback for when no model can be reached.
    const shortReply = inAppShortReply(caption, priorHistory.filter(turn => turn.role === "user").at(-1)?.content ?? "");
    if (shortReply) return { reply: shortReply, escalated: false, retryable: true };
    const fact = relevantFact(caption, snapshot);
    return {
      reply: `${fact}I couldn't reach my answer service just now. Please tap "Try again" in a minute.`.trim(),
      escalated: false,
      retryable: true,
    };
  }

  // 3b. A provider answered and genuinely doesn't know → a human takes it.
  console.info("[support-bot] reply", { path: "escalation", retrieval: retrieval.method, faqCount: knowledgeBase.length });
  const result = await fileForTeam(db, studentId, snapshot, message);

  const fact = relevantFact(caption, snapshot);
  if (input.waitingOnTeam) {
    // Already with the team. recordUnknownQuestion above only bumps its
    // "asked N times" count; don't announce a second escalation.
    return {
      reply: `${fact ? `Here's what I can confirm: ${fact}` : ""}I've added this to your open request — the support team already has it and will reply here. You'll get a notification when they do.`,
      escalated: false,
    };
  }
  return {
    reply: `${fact ? `Here's what I can confirm: ${fact}` : ""}I don't have a confirmed answer to this yet, so I've sent your question to the support team. Their reply will appear right here in this chat and you'll get a notification. You can keep asking me other things meanwhile.`,
    escalated: true,
    unknownQuestionId: result.saveFailed ? null : result.id,
  };
}
