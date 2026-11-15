/**
 * Rule-based intent detection for the WhatsApp pipeline (Component 3B).
 *
 * Pure functions — no I/O. Runs BEFORE Gemini and handles the vast
 * majority of real student messages without ever hitting the LLM.
 *
 * Covers English + Hinglish + Telugu transliteration (the actual mix
 * students at GNIT/GNITC send).
 *
 * Matching strategy:
 *   Phase 1 — phrases (longer/specific, always checked first)
 *   Phase 2 — single tokens (broader, only when no phrase matched)
 *
 * Within each phase, priority:
 *   GREETING → THANK_YOU → GOODBYE → PAYMENT → STATUS → REGISTER
 *
 * Returns null when no rule fires — caller falls through to Gemini.
 * Never throws.
 */

import type { Intent } from "@/lib/intent-engine/types";

// ── Text normalisation ──────────────────────────────────────────────────────

export interface NormalisedText {
  /** Original text, NFC-normalised and whitespace-collapsed — use for storage. */
  original: string;
  /** Lowercased copy of original — use for matching only, never for storage. */
  lower: string;
}

export function normaliseText(raw: string): NormalisedText {
  const original = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  return { original, lower: original.toLowerCase() };
}

// ── Keyword / phrase tables ─────────────────────────────────────────────────

/** Registration intent → MENU_REQUEST */
const REGISTER_PHRASES = [
  // English
  "i want to register", "i want to join", "how to register",
  "how do i register", "how can i register", "want to register",
  "want to join", "want to enroll", "how to enroll", "how to join",
  "i need to register", "register cheyali", "join cheyali",
  "ela register", "ela join", "register avvadam ela",
  "register cheyyali", "join cheyyali", "enroll avvali",
  "course join", "batch join", "class join",
  "how to take admission", "i want admission",
  "nenu register", "naaku register", "nenu join",
  "registration ela cheyali", "join ela cheyali",
];
const REGISTER_WORDS = [
  "register", "registration", "enroll", "enrollment",
  "admission", "admissions", "join", "joining",
  // Telugu transliteration
  "register", "rejistration", "rejister",
];

/** Status queries → STATUS_REQUEST */
const STATUS_PHRASES = [
  "registration status", "payment status", "batch status", "petition status",
  "my status", "check status", "what is my status", "whats my status",
  "what is status", "tell me status", "show my status",
  "status cheppandi", "status cheppu", "naaku status",
  "em jarigindi", "em ayindi", "enti status",
  "fee status", "course status", "application status",
];
const STATUS_WORDS = ["status"];

/** Fee / payment questions → STUDENT_SUPPORT */
const PAYMENT_PHRASES = [
  // English
  "how much", "petition fee", "registration fee", "course fee",
  "what is the fee", "what is the amount", "how much amount",
  "how much is the fee", "how much do i need", "how much should i pay",
  "total amount", "fee amount", "payment failed", "payment not done",
  "paid already", "i already paid", "my payment", "payment issue",
  "fee not paid", "fee paid", "i paid", "payment done",
  "payment not received", "payment showing pending",
  "money deducted", "amount deducted", "amount debited",
  "transaction failed", "upi failed", "phonepe failed",
  // Telugu / Hinglish
  "fee entha", "fee ela", "fee chellinchadam ela",
  "pay chesanu", "pay cheyali", "fee pay", "fee kathadam ela",
  "naaku fee", "evvaru fee", "fee eppudu", "fee kattu",
  "money poyindi", "money cut", "amount poyindi",
  "payment aipoyindi", "payment kaaledu", "fee kaaledu",
];
const PAYMENT_WORDS = [
  "fee", "fees", "amount", "payment", "paid", "pay",
  "transaction", "utr", "upi", "phonepe", "gpay", "paytm",
  "price", "discount", "cost", "refund", "money",
  // Telugu
  "fii", "kattu", "kattadam",
];

/** Social greetings → GREETING */
const GREETING_PHRASES = [
  "good morning", "good evening", "good afternoon", "good night",
  "good day", "gud morning", "gud evening", "gud afternoon",
  "hello sir", "hello madam", "hello mam", "hello team",
  "hi sir", "hi madam", "hi mam", "hi team",
  "namaste ji", "namaskar",
];
const GREETING_WORDS = [
  "hi", "hii", "hiii", "hiiii", "hello", "helo", "hey", "heyy", "heya",
  "hai", "namaste", "namaskar", "namasthe", "vanakkam",
  "hlo", "hola", "yo", "sup",
];

/** Thanks → THANK_YOU */
const THANKS_PHRASES = [
  "thank you", "thanks a lot", "many thanks", "thank u",
  "thanks so much", "thank you so much", "bahut shukriya",
  "chala thanks", "chala manchiga", "thank you sir", "thank you mam",
  "ok thank you", "ok thanks", "okay thanks",
];
const THANKS_WORDS = [
  "thanks", "thankyou", "thanku", "tq", "thq", "ty", "thx",
  "shukriya", "dhanyawad",
];

/** Goodbye → GOODBYE */
const BYE_PHRASES = [
  "see you", "see u", "good bye", "take care", "talk later",
  "will contact later", "i will come back", "ok bye", "ok goodbye",
  "bye sir", "bye mam", "bye team",
];
const BYE_WORDS = [
  "bye", "goodbye", "cya", "bbye", "byee",
];

/** Certificate / document queries → STUDENT_SUPPORT */
const CERTIFICATE_PHRASES = [
  "need certificate", "want certificate", "certificate issue",
  "bonafide certificate", "tc certificate", "transfer certificate",
  "migration certificate", "character certificate",
  "certificate download", "certificate not received",
  "certificate ela", "certificate cheppandi",
];
const CERTIFICATE_WORDS = [
  "certificate", "bonafide", "tc", "marksheet", "transcript",
];

// ── Matching helpers ────────────────────────────────────────────────────────

function matchesPhrase(lower: string, phrases: string[]): boolean {
  return phrases.some(p => lower.includes(p));
}

function matchesWord(lower: string, words: string[]): boolean {
  const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  return words.some(w => tokens.has(w));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * True when the text is specifically a request to *register / join*, as
 * opposed to a generic "show me the menu". Both currently map to
 * MENU_REQUEST in detectByRules(), which is why typing "register" only
 * re-showed the menu instead of starting registration the way tapping the
 * Register row does. The router uses this to tell the two apart. Generic
 * menu/help words ("menu", "help", "start") are deliberately NOT in the
 * REGISTER tables, so they don't trigger registration.
 */
export function isRegisterIntent(lower: string): boolean {
  return matchesPhrase(lower, REGISTER_PHRASES) || matchesWord(lower, REGISTER_WORDS);
}

/**
 * True only when the student is EXPLICITLY asking to see the menu / options,
 * as opposed to any greeting. Used so the bot stops dumping the main menu on
 * every "hi" and instead reserves it for a real "menu"/"help"/"options"
 * request — the assistant handles everything else conversationally.
 */
// Bare single-word commands only. NOT loose token matching: "start" and
// "menu" appear inside real questions ("when does batch start", "what's on
// the menu"), and those must go to the assistant, not re-open the menu.
const MENU_EXACT = new Set(["menu", "help", "options", "start", "main menu", "show menu"]);
const MENU_PHRASES = ["show menu", "show options", "see options", "list of options", "what can you do", "what can u do", "help me"];
export function isExplicitMenuRequest(lower: string): boolean {
  const trimmed = lower.trim().replace(/[.!?]+$/, "");
  if (MENU_EXACT.has(trimmed)) return true;
  return matchesPhrase(trimmed, MENU_PHRASES);
}

// ── Action-intent detection (Issue #42: AI Workflow Protection) ──────────────
// When a message maps to an existing workflow, the bot must LAUNCH that
// workflow (a structured action) instead of letting the conversational LLM
// answer over it. The assistant is only for genuine questions / help.
//
// The distinction that matters: "check / what is my payment status" wants the
// STATUS (→ launch the workflow), while "WHY is my payment pending" wants an
// explanation (→ let the assistant answer). So an explanation cue short-
// circuits action detection.

const EXPLANATION_CUE = /\b(why|explain|reason|how come)\b/;

const PAYMENT_STATUS_PHRASES = [
  "payment status", "my payment status", "status of my payment", "payment update",
  "check my payment", "check payment", "is my payment", "has my payment",
  "did my payment", "payment approved", "payment approve", "payment done",
  "payment received", "payment verified", "payment confirmed", "payment success",
  "fee status", "fee paid or not", "paid or not",
  // Telugu / Hinglish
  "payment ayinda", "payment approve ayinda", "payment aindaa", "fee status enti",
];
const REGISTRATION_STATUS_PHRASES = [
  "registration status", "my registration status", "status of my registration",
  "am i registered", "are we registered", "check my registration",
  "registration done", "registration approved", "registration confirmed",
  "registration ayinda", "registered or not",
];
const GENERIC_STATUS_PHRASES = [
  "my status", "check status", "check my status", "what is my status",
  "whats my status", "application status", "status cheppu", "status cheppandi",
];

/**
 * "How many students have registered / how many seats" style questions. These
 * are answered deterministically with the live batch count + petition-minimum
 * note, so the bot gives a real number instead of dumping the register menu
 * (and works even when the Groq assistant is unavailable). Checked BEFORE the
 * register intent because "how many registered" contains the word "register".
 */
const SEAT_COUNT_PHRASES = [
  "how many registered", "how many have registered", "how many are registered",
  "how many students", "how many student", "how many joined", "how many have joined",
  "how many enrolled", "how many people", "how many members", "how many candidates",
  "how many till date", "how many so far", "how many are there", "how many did register",
  "how many seats", "seats filled", "seats left", "seat count", "seats available",
  "student count", "total registered", "total registration", "total registrations",
  "registration count", "number of students", "no of students", "count of students",
  "present count", "current count", "registered till date", "registered so far",
  // Telugu / Hinglish
  "entha mandi", "enthamandi", "enni mandi", "enni seats", "kitne log", "kitne register",
  "kitne students", "entha mandi register",
];
export function isSeatCountIntent(lower: string): boolean {
  return matchesPhrase(lower, SEAT_COUNT_PHRASES);
}

/**
 * "How do I get/open the Student App" — the app has no in-chat login of its
 * own; students log in on the website with phone + a WhatsApp one-time
 * code. Found live: an admin's FAQ answer to "App download" told a student
 * to "type login", which isn't a real command — the student did exactly
 * that and it just created ANOTHER unanswered-question ticket instead of
 * doing anything, because nothing here recognised "login" as an actual
 * request. This makes that literal word (and its natural phrasings) send
 * the real link, so "type login" and similar FAQ answers actually work.
 */
const APP_LOGIN_PHRASES = [
  "app login", "log in",
  "login code", "verification code", "one time password",
];
const APP_LOGIN_WORDS = ["login", "signin", "app", "otp"];
export function isAppLoginIntent(lower: string): boolean {
  return matchesPhrase(lower, APP_LOGIN_PHRASES) || matchesWord(lower, APP_LOGIN_WORDS);
}

/**
 * "Send me the app link" — the sender wants the Student App URL itself,
 * NOT a login code. This is a separate intent from app_login on purpose:
 * app_login sends a 6-digit code, app_link sends the URL. Before this,
 * "app link" lived inside APP_LOGIN_PHRASES, so the keyword fallback sent
 * a code — and the AI-first path had no grounded app-link fact, so the
 * model wrote a reply with a "[link]" placeholder (or "I'll send you the
 * link"), which the output guard replaced with the "I couldn't finish that
 * reply" fallback. Live 9 Nov 2026: "App link" and bare "Link" both hit
 * that fallback, for the admin and for students.
 *
 * Matching is deliberately narrow: bare "link" is an EXACT match only (the
 * whole message is just "link"), never a loose word — otherwise
 * "registration link" / "payment link" would be swallowed by this intent.
 * The phrases are all multi-word and link-specific for the same reason.
 */
const APP_LINK_PHRASES = [
  "app link", "student app link", "student platform link", "platform link", "the app link",
  "send the app link", "send me the app link", "send me the link", "send link",
  "give me the app link", "give me the link", "give link",
  "share the app link", "share me the link", "share link",
  "get the app link", "get the link", "get link",
  "app url", "app website", "website link",
  "download app", "download the app", "install app", "install the app",
  "get the app", "open the app", "student app", "app download",
  "app kaise", "app ela", "link kavali", "link ivvandi", "link please",
];
const APP_LINK_EXACT = new Set(["link", "app", "applink", "app-link", "get app", "app please"]);
export function isAppLinkIntent(lower: string): boolean {
  const t = lower.trim().replace(/[.!?]+$/, "");
  if (APP_LINK_EXACT.has(t)) return true;
  return matchesPhrase(t, APP_LINK_PHRASES);
}

/**
 * True when the bot's own last message was asking WHICH COLLEGE to look up
 * the fee for (Gemini's own clarifying question — see buildSystemPrompt's
 * SCOPE, "fees & payment"), as opposed to a "which college to register"
 * prompt. Live bug: a student replied "Fee" -> bot asked "Reply GNIT or
 * GNITC and I'll tell you the fee" -> replying "Gnit" got caught by the
 * bare-college-name shortcut in router.ts, which ALWAYS meant "start
 * registering" and sent a registration link instead of the fee. Router.ts
 * checks this before assuming a bare college name means registration.
 */
export function isFeeClarifyingReply(lastBotMessage: string): boolean {
  // "registration fee" is normal phrasing inside a genuine fee question, so
  // excluding on any mention of "regist" is wrong — the real differentiator
  // is whether the bot's message goes on to offer a registration LINK
  // (that prompt is asking which college to register, not which college's
  // fee to look up).
  return /\bfee\b/i.test(lastBotMessage) && !/\blink\b/i.test(lastBotMessage);
}

/**
 * True when a message looks like a genuine, substantive question worth
 * auto-learning as an FAQ draft (see saveDraftFaq, services/faq.ts) — as
 * opposed to gibberish/keyboard-mash ("Hjs") that the assistant now
 * answers conversationally instead of escalating (see the "meaningless"
 * clause in buildSystemPrompt) but that is NOT a real Q&A worth saving.
 * Deliberately a coarse length check, not a quality judgement — a short
 * but real question ("fee?") is rare enough that missing it costs
 * nothing, while saving every one-word test message would flood the
 * review queue with noise.
 */
export function looksLikeRealQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= 3;
}

export type ActionIntent = "register" | "payment_status" | "registration_status" | "menu" | "seat_count" | "app_login" | "app_link";

/**
 * Returns the workflow to LAUNCH for this message, or null if it's a genuine
 * question/help message the conversational assistant should handle.
 */
export function detectActionIntent(lower: string): ActionIntent | null {
  const t = lower.trim().replace(/[.!?]+$/, "");
  if (isExplicitMenuRequest(t)) return "menu";
  // Wants an explanation, not the value/action itself → assistant, not a workflow.
  if (EXPLANATION_CUE.test(t)) return null;
  // Specific status phrases are checked BEFORE the generic register word, so
  // "registration status" launches the status workflow rather than being
  // swallowed by isRegisterIntent (which matches the word "registration").
  if (matchesPhrase(t, PAYMENT_STATUS_PHRASES)) return "payment_status";
  if (matchesPhrase(t, REGISTRATION_STATUS_PHRASES)) return "registration_status";
  // "how many registered / seats" → the seat-count answer. Checked before the
  // register intent, since "how many registered" contains "register".
  if (isSeatCountIntent(t)) return "seat_count";
  // App link BEFORE app login: "app link" wants the URL, not a code. The
  // link phrases used to live in the login intent, so the fallback sent a
  // code — and the AI-first path had no grounded app-link fact, so it wrote
  // a "[link]" placeholder the output guard replaced with the fallback.
  if (isAppLinkIntent(t)) return "app_link";
  if (isAppLoginIntent(t)) return "app_login";
  // A bare "my status" is ambiguous between payment/registration — show the
  // menu so the student picks, rather than guessing or chatting.
  if (matchesPhrase(t, GENERIC_STATUS_PHRASES)) return "menu";
  if (isRegisterIntent(t)) return "register";
  return null;
}

export function detectByRules(lower: string): Intent | null {
  // Phase 1 — phrases (most specific)
  if (matchesPhrase(lower, GREETING_PHRASES))     return "GREETING";
  if (matchesPhrase(lower, THANKS_PHRASES))        return "THANK_YOU";
  if (matchesPhrase(lower, BYE_PHRASES))           return "GOODBYE";
  if (matchesPhrase(lower, PAYMENT_PHRASES))       return "STUDENT_SUPPORT";
  if (matchesPhrase(lower, STATUS_PHRASES))        return "STATUS_REQUEST";
  if (matchesPhrase(lower, REGISTER_PHRASES))      return "MENU_REQUEST";
  if (matchesPhrase(lower, CERTIFICATE_PHRASES))   return "STUDENT_SUPPORT";

  // Phase 2 — single tokens
  if (matchesWord(lower, GREETING_WORDS))    return "GREETING";
  if (matchesWord(lower, THANKS_WORDS))      return "THANK_YOU";
  if (matchesWord(lower, BYE_WORDS))         return "GOODBYE";
  if (matchesWord(lower, PAYMENT_WORDS))     return "STUDENT_SUPPORT";
  if (matchesWord(lower, CERTIFICATE_WORDS)) return "STUDENT_SUPPORT";
  if (matchesWord(lower, STATUS_WORDS))      return "STATUS_REQUEST";
  if (matchesWord(lower, REGISTER_WORDS))    return "MENU_REQUEST";

  return null;
}
