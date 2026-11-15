import { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/services/students";

/**
 * WhatsApp message moderation + first-contact personalization.
 *
 * Gap being fixed: every free-text message that wasn't an exact "hi"/"hello"
 * match fell straight into handleFreeTextQuestion() — FAQ search, then
 * recordUnknownQuestion() + admin notify. So "Good morning", "Thanks",
 * "How are you", "Stupid", "My gf is not working" were all stored as
 * unknown questions and forwarded to the admin exactly like a real
 * "payment issue" question would be.
 *
 * Classifies incoming text into:
 *   - greeting_open  ("hi", "good morning", ...)  → show menu, don't store
 *   - greeting_close ("thanks", "bye", ...)        → acknowledge, don't store
 *   - spam           (chit-chat, abuse, repeats)   → progressive ladder below,
 *                                                     never forwarded to admin
 *   - question       (anything else)               → unchanged existing
 *                                                     FAQ/unknown-question path
 *
 * No embeddings or external AI — same rule-based approach the FAQ engine
 * itself already uses (see services/faq.ts).
 *
 * Escalation ladder, backed by whatsapp_moderation (migration 0030 + the
 * preferred_name column added alongside it). Personalized by name, warm
 * but firm — not shaming:
 *   1st consecutive off-topic message → explain the bot's scope
 *   2nd consecutive                   → firmer note
 *   3rd consecutive                   → final warning
 *   4th consecutive                   → muted (15 min first time, 1h next,
 *                                        24h after that — consecutive count
 *                                        resets after each mute)
 *   Offending again after the 24h tier has already been used            →
 *                                        flagged for admin review, NOT
 *                                        auto-restricted further.
 *   Permanent block is only ever set by an explicit admin command
 *   (RESTRICT PERMANENT / UNRESTRICT in admin.ts) — never automatic.
 *
 * Column reuse note: this table's `abuse_count` holds the *consecutive*
 * off-topic count (resets on a genuine/greeting message) and
 * `restriction_count` holds the mute tier reached (0=none, 1=15min served,
 * 2=1h served, 3=24h served) — reusing migration 0030's columns rather
 * than adding more, since their meaning maps directly onto this ladder.
 */

const MUTE_DURATIONS_MS = [15 * 60_000, 60 * 60_000, 24 * 60 * 60_000]; // 15min, 1h, 24h
const MUTE_LABELS = ["15-minute", "1-hour", "24-hour"];

/**
 * Opening greetings that deserve a greeting reply — "hi", "hello", "good
 * morning", ... — but NOT "menu"/"help"/"start": those are commands, and
 * for an admin they must reach the admin command list, not a greeting.
 * Shared by the first-message branch below and the admin greeting
 * intercept in the router, so the two can never drift apart.
 */
const WELCOME_GREETINGS = new Set([
  "hi", "hii", "hiii", "hiiii", "hello", "helo", "hey", "heyy", "heya",
  "good morning", "good afternoon", "good evening", "gm", "morning",
  "hai", "hlo", "hola", "yo", "sup", "namaste", "namaskar", "namasthe",
]);

export function isWelcomeGreeting(text: string): boolean {
  return WELCOME_GREETINGS.has(text.trim().toLowerCase().replace(/[.!?]+$/, ""));
}

const OPENING_GREETINGS = new Set([
  "hi", "hii", "hiii", "hiiii", "hello", "helo", "hey", "heyy", "heya",
  "good morning", "good afternoon", "good evening", "gm", "morning",
  "start", "menu", "help",
]);

const CLOSING_GREETINGS = new Set([
  "thanks", "thank you", "thankyou", "thanks a lot", "thank u", "ty", "tq",
  "thanks!", "thank you!", "ok thanks", "okay thanks", "great thanks",
  "bye", "goodbye", "bye bye", "ok bye", "see you", "cya",
  // A BARE acknowledgment — the exact whole message, nothing else — is a
  // closing remark, not a question. A student replying just "Okay" to
  // something the bot already told them was falling through to "question",
  // failing every FAQ/AI attempt to answer it (there's nothing to answer),
  // and getting recorded + escalated to admin as an unanswered question.
  "ok", "okay", "okk", "k", "kk", "got it", "noted", "cool", "fine", "alright", "sure",
]);

/** Individual words that only ever show up in a sign-off, never in a real
 *  question. A message built ENTIRELY from these (e.g. "Okay thankyou",
 *  "ok thanks bye") is still a closing remark even though it's not one of
 *  the exact phrases spelled out in CLOSING_GREETINGS above — confirmed
 *  live: "Okay thankyou" was still reaching the admin as an unanswered
 *  question after that fix. Capped at 5 words so this can't accidentally
 *  swallow a real sentence that happens to be built from short words. */
const CLOSING_WORDS = new Set([
  "ok", "okay", "okk", "k", "kk", "thanks", "thank", "thankyou", "tq", "ty",
  "u", "you", "bye", "goodbye", "cya", "see", "great", "got", "it", "noted",
  "cool", "fine", "alright", "sure", "a", "lot",
]);

function isAllClosingWords(lower: string): boolean {
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  return words.every(w => CLOSING_WORDS.has(w));
}

const OFF_TOPIC_PHRASES = [
  // General chit-chat
  "how are you", "how r u", "how you doing", "what's up", "whats up", "wassup",
  "who are you", "are you human", "are you a bot", "are you real",
  "tell me a joke", "sing a song", "i love you", "marry me",
  "good night", "what is your name", "whats your name", "how old are you",
  // Indian / Telugu specific off-topic
  "what are you doing", "what r u doing", "kya kar rahe ho", "kaise ho",
  "aap kaun ho", "aap kya ho", "kya tum bot ho", "ek joke batao",
  "nuvvu ela unnav", "nuvvu evaru", "mee peru enti", "oka joke cheppu",
  "ninu prema", "nenu ninu love", "nuvvu bot na", "nuvvu manushuda",
  "em chestunnaru", "em chestunnav",
  // Irrelevant requests — note: generic "send me" / "can you send" /
  // "share with me" are intentionally NOT here, because they match genuine
  // student requests ("can you send me the registration link"). Only the
  // number-harvesting variants below are treated as off-topic.
  "send your number", "give your number", "what is your number",
  "cricket score", "today match", "ipl score", "weather today",
  "news today", "stock price", "share price",
  // Matrimony/dating-site messages — a stranger who mixed this WhatsApp
  // number up with a matrimony profile, not a student. "matrimony" alone
  // is never going to appear in a genuine registration/fee/payment
  // question, so it's a safe, low-risk signal on its own.
  "matrimony", "your profile", "shaadi.com", "jeevansathi", "bharat matrimony",
];

const ABUSE_WORDS = [
  "stupid", "idiot", "nonsense", "useless bot", "shut up",
  "fool", "dumb bot", "garbage bot", "rubbish bot", "worthless bot", "hate this bot",
  // Plain English profanity — found live: "Fuck"/"Fuckoff" matched nothing
  // here, fell through to "question", and got escalated to the admin's
  // WhatsApp as an unanswered student question instead of being handled by
  // the actual abuse ladder (explain scope → firmer note → warning → mute).
  "fuck", "fucking", "fuckoff", "fuck off", "wtf", "bullshit",
  "bastard", "bitch", "asshole", "motherfucker",
  // Hinglish / Telugu abuse
  "bekaar", "bakwas", "chutiya", "pagal", "bewakoof",
  "bhosdi", "madarchod", "behenchod", "harami",
  // "dabbulu" (Telugu for "money") deliberately excluded — it's the bot's
  // core topic, not abuse; genuine payment complaints use it.
  "poda", "poyi", "waste bot", "pichchi bot",
];

const PERSONAL_LIFE_HINTS = [
  "girlfriend", "boyfriend", " gf ", " gf,", " gf.", "my gf", " bf ", "my bf",
  "breakup", "break up", "left me", "crush on", "dating someone",
  // Indian / Telugu personal life
  "prema", "love letter", "my love", "i miss you", "missing you",
  "propose", "marriage", "shaadi", "kalyanam", "naa prema",
  "friend problem", "family problem", "personal problem",
];

function isRepeatedCharSpam(text: string): boolean {
  const stripped = text.replace(/\s/g, "");
  if (stripped.length < 6) return false;
  const counts: Record<string, number> = {};
  for (const ch of stripped) counts[ch] = (counts[ch] ?? 0) + 1;
  const max = Math.max(...Object.values(counts));
  return max / stripped.length > 0.8;
}

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
function isEmojiSpam(text: string): boolean {
  const emojis = text.match(EMOJI_REGEX);
  if (!emojis || emojis.length < 4) return false;
  const nonEmojiLen = text.replace(EMOJI_REGEX, "").trim().length;
  return nonEmojiLen === 0;
}

type ContentClass = "greeting_open" | "greeting_close" | "spam" | "question";

export function classifyContent(rawText: string): ContentClass {
  const text = rawText.trim();
  const lower = text.toLowerCase().replace(/[.!?]+$/, "");

  if (OPENING_GREETINGS.has(lower)) return "greeting_open";
  if (CLOSING_GREETINGS.has(lower)) return "greeting_close";
  if (isAllClosingWords(lower)) return "greeting_close";
  if (isRepeatedCharSpam(text) || isEmojiSpam(text)) return "spam";
  if (OFF_TOPIC_PHRASES.some(p => lower.includes(p))) return "spam";
  if (ABUSE_WORDS.some(w => lower.includes(w))) return "spam";
  if (PERSONAL_LIFE_HINTS.some(h => lower.includes(h))) return "spam";

  return "question";
}

interface ModerationRow {
  phone: string;
  abuse_count: number;           // consecutive off-topic count
  last_abuse_at: string | null;
  restricted_until: string | null;
  restriction_count: number;     // mute tier reached (0..3)
  permanently_restricted: boolean;
  flagged_for_review_at: string | null;
  last_message: string | null;
  last_message_at: string | null;
  repeat_count: number;
  preferred_name: string | null;
  last_intent: string | null;
  last_intent_at: string | null;
  awaiting_support_message: boolean;
  awaiting_id_reupload: boolean;
}

// Greetings, interjections and filler that students very often send as their
// FIRST reply after "what should I call you?" — none of these are a name.
// Production data had "Hi", "Bro", "Yesss", "I'm a student" saved as people's
// names because the old check accepted anything short and non-question.
const NOT_A_NAME = new Set([
  "hi","hii","hiii","hello","helo","hey","heyy","heya","hai","yo","sup","hola","hlo",
  "yes","yess","yesss","yep","yeah","ya","ok","okay","okk","k","kk","hmm","hmmm",
  "no","nope","na","naa","haan","haa","sure","fine","good","nice","cool","great","done",
  "bro","bhai","anna","sir","madam","mam","boss","dude","buddy","bud","brother",
  "thanks","thank you","thankyou","ty","tq","welcome","namaste","namaskar",
  "student","students","admin","user","guest","me","myself","test","testing","none","nothing",
  "start","menu","help","morning","gm",
  // Commands/abbreviations a first-time contact reflexively types instead of
  // an actual name, guessing at what the bot wants ("REG" for "register").
  // "Nice to meet you, REG!" was live in production — none of these are
  // plausible real names, so blocking them outright is safe.
  "reg","regi","register","gnit","gnitc","status","pay","payment","faq","link","verify",
]);

// Common lead-ins students type before their actual name — stripped so
// "I am Aqsah" / "my name is Rahul" capture "Aqsah" / "Rahul", not the sentence.
const NAME_PREFIX = /^(i\s*am|i'?m|iam|my\s*name\s*is|name\s*is|this\s*is|call\s*me|myself|name)\s+/i;

// Topic words that mean the message is a real question/request, not a name.
const NON_NAME_HINTS = [
  "payment", "register", "registration", "fee", "certificate", "petition",
  "batch", "help", "issue", "problem", "not working", "status", "college",
  "document", "court", "refund", "amount", "how", "when", "where", "why", "what",
];

/**
 * Extracts a plausible display name from a reply to "what should I call you?",
 * or null if the message clearly isn't a name (a greeting, filler, or a real
 * question). Returning null is safe: the message falls through to normal
 * processing and the name is simply asked for / captured later — a false
 * positive is worse, because it both corrupts the stored name AND swallows
 * whatever the student actually said (P0-001).
 */
function extractName(raw: string): string | null {
  let t = raw.trim().replace(/[\n\r]+/g, " ").replace(/\s+/g, " ");
  if (!t || t.includes("?")) return null;
  t = t.replace(NAME_PREFIX, "").trim();
  if (!t || t.length > 40) return null;

  const lower = t.toLowerCase();
  if (NOT_A_NAME.has(lower)) return null;
  if (NON_NAME_HINTS.some(h => lower.includes(h))) return null;

  const words = t.split(" ");
  if (words.length > 4) return null; // a sentence, not a name
  // Any single word that is itself pure filler ("ok bro" → reject) disqualifies.
  if (words.some(w => NOT_A_NAME.has(w.toLowerCase()))) return null;
  // A name is letters (any script) plus spaces / . ' - — no digits or symbols.
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(t)) return null;

  return t.slice(0, 40);
}

function emptyRow(phone: string): ModerationRow {
  return {
    phone: normalizePhone(phone), abuse_count: 0, last_abuse_at: null, restricted_until: null,
    restriction_count: 0, permanently_restricted: false, flagged_for_review_at: null,
    last_message: null, last_message_at: null, repeat_count: 0, preferred_name: null,
    last_intent: null, last_intent_at: null, awaiting_support_message: false,
    awaiting_id_reupload: false,
  };
}

async function loadRow(db: SupabaseClient, phone: string): Promise<ModerationRow | null> {
  const p = normalizePhone(phone);
  const { data } = await db.from("whatsapp_moderation").select("*").eq("phone", p).maybeSingle();
  return data as ModerationRow | null;
}

async function saveRow(db: SupabaseClient, row: ModerationRow): Promise<void> {
  const { error } = await db.from("whatsapp_moderation")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "phone" });
  if (error) console.error("[MODERATION] saveRow failed:", error.message, "code:", error.code, "phone:", row.phone);
}

/** Marks that Contact Support was just tapped — the student's next message should skip FAQ matching and go straight to admin. */
export async function setAwaitingSupportMessage(db: SupabaseClient, phone: string): Promise<void> {
  const p = normalizePhone(phone);
  // Use last_intent as the durable fallback marker as well as the dedicated
  // flag. This keeps Contact Support working even if migration 0033 has not
  // reached a particular environment yet.
  await db.from("whatsapp_moderation").upsert({
    phone: p,
    last_intent: "CONTACT_SUPPORT",
    last_intent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    awaiting_support_message: true,
  }, { onConflict: "phone" }).then(async ({ error }) => {
    if (!error) return;
    // Backward-compatible fallback when awaiting_support_message is absent.
    await db.from("whatsapp_moderation").upsert({
      phone: p,
      last_intent: "CONTACT_SUPPORT",
      last_intent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });
  });
}

/** Checks and clears the support prompt marker. A recent CONTACT_SUPPORT intent
 * is accepted as a fallback so the student's next message cannot accidentally
 * enter FAQ/college-search handling when the dedicated column is unavailable. */
export async function consumeAwaitingSupportMessage(db: SupabaseClient, phone: string): Promise<boolean> {
  const row = await loadRow(db, phone);
  if (!row) return false;

  const recentSupportIntent =
    row.last_intent === "CONTACT_SUPPORT" &&
    !!row.last_intent_at &&
    Date.now() - new Date(row.last_intent_at).getTime() >= 0 &&
    Date.now() - new Date(row.last_intent_at).getTime() <= 30 * 60 * 1000;

  if (!row.awaiting_support_message && !recentSupportIntent) return false;

  // Clear the durable fallback first so exactly one following message is
  // consumed as the support request.
  await db.from("whatsapp_moderation").update({
    last_intent: null,
    last_intent_at: null,
    updated_at: new Date().toISOString(),
  }).eq("phone", normalizePhone(phone));

  // Clear the dedicated flag too when the column exists; ignore the update
  // error in older environments where migration 0033 is not applied.
  await db.from("whatsapp_moderation").update({
    awaiting_support_message: false,
    updated_at: new Date().toISOString(),
  }).eq("phone", normalizePhone(phone));

  return true;
}

/** Marks that the student was just asked to send their corrected College ID photo. */
export async function setAwaitingIdReupload(db: SupabaseClient, phone: string): Promise<void> {
  const row = (await loadRow(db, phone)) ?? emptyRow(phone);
  row.awaiting_id_reupload = true;
  await saveRow(db, row);
}

/** Checks and clears the flag in one step. True means: the image that just arrived IS the corrected College ID, not a random photo. */
export async function consumeAwaitingIdReupload(db: SupabaseClient, phone: string): Promise<boolean> {
  const row = await loadRow(db, phone);
  if (!row?.awaiting_id_reupload) return false;
  row.awaiting_id_reupload = false;
  await saveRow(db, row);
  return true;
}

export type ModerationVerdict =
  | { kind: "blocked_permanent" }
  | { kind: "blocked_temp"; until: string }
  | { kind: "ask_name" }                                  // brand new contact — send welcome + name prompt
  | { kind: "name_collected"; name: string }               // this message WAS their name reply
  | { kind: "greeting_open" }
  | { kind: "greeting_close" }
  | { kind: "spam_notice_1"; name: string | null }
  | { kind: "spam_notice_2"; name: string | null }
  | { kind: "spam_final_warning"; name: string | null }
  | { kind: "spam_muted"; name: string | null; until: string; label: string }
  | { kind: "spam_flagged_for_review"; name: string | null }
  | { kind: "genuine" };

/**
 * Single entry point — call this before any free-text message is handled.
 */
export async function moderateIncomingText(
  db: SupabaseClient, phone: string, text: string
): Promise<ModerationVerdict> {
  let row = await loadRow(db, phone);

  // First-ever message from this number.
  // A real opening greeting (Hi/Hello/Hey/etc.) should immediately get the
  // Student Support welcome + tappable options. Do NOT force a name prompt
  // before showing the service — that was the reason a brand-new "Hi" could
  // never reach the welcome flow the user was supposed to see.
  // Other first messages still use the existing name-capture flow.
  if (!row) {
    await saveRow(db, emptyRow(phone));
    if (isWelcomeGreeting(text)) return { kind: "greeting_open" };
    return { kind: "ask_name" };
  }

  const extractedName = row.preferred_name === null ? extractName(text) : null;
  if (extractedName) {
    row.preferred_name = extractedName;
    await saveRow(db, row);
    return { kind: "name_collected", name: extractedName };
  }
  // preferred_name still null and this doesn't look like a name reply —
  // don't swallow it. Fall through to normal processing below (name stays
  // null; every verdict already treats `name` as nullable and personalizes
  // with a neutral fallback, so nothing downstream breaks).

  if (row.permanently_restricted) return { kind: "blocked_permanent" };
  if (row.restricted_until && new Date(row.restricted_until) > new Date()) {
    return { kind: "blocked_temp", until: row.restricted_until };
  }

  const content = classifyContent(text);

  if (content === "greeting_open" || content === "greeting_close") {
    if (row.abuse_count > 0) { row.abuse_count = 0; await saveRow(db, row); }
    return content === "greeting_open" ? { kind: "greeting_open" } : { kind: "greeting_close" };
  }

  // Repeated-identical-message tracking, independent of the off-topic
  // ladder — 3x the same text within 10 minutes counts as spam content
  // even if the text itself would otherwise look like a question.
  const normalized = text.trim().toLowerCase();
  const withinWindow = !!row.last_message_at
    && (Date.now() - new Date(row.last_message_at).getTime()) < 10 * 60 * 1000;
  const isRepeat = withinWindow && row.last_message === normalized;
  row.repeat_count = isRepeat ? row.repeat_count + 1 : 1;
  row.last_message = normalized;
  row.last_message_at = new Date().toISOString();

  const isSpam = content === "spam" || row.repeat_count >= 3;

  if (!isSpam) {
    if (row.abuse_count > 0) row.abuse_count = 0; // a genuine question resets the consecutive counter
    await saveRow(db, row);
    return { kind: "genuine" };
  }

  row.abuse_count += 1; // consecutive off-topic count
  row.last_abuse_at = new Date().toISOString();
  const name = row.preferred_name;

  if (row.abuse_count === 1) { await saveRow(db, row); return { kind: "spam_notice_1", name }; }
  if (row.abuse_count === 2) { await saveRow(db, row); return { kind: "spam_notice_2", name }; }
  if (row.abuse_count === 3) { await saveRow(db, row); return { kind: "spam_final_warning", name }; }

  // 4th+ consecutive off-topic message → mute.
  if (row.restriction_count >= MUTE_DURATIONS_MS.length) {
    // Already served the 24h tier before and still offending — admin's call now.
    row.flagged_for_review_at = new Date().toISOString();
    await saveRow(db, row);
    return { kind: "spam_flagged_for_review", name };
  }

  const durationMs = MUTE_DURATIONS_MS[row.restriction_count];
  const label = MUTE_LABELS[row.restriction_count];
  const until = new Date(Date.now() + durationMs).toISOString();
  row.restricted_until = until;
  row.restriction_count += 1;
  row.abuse_count = 0; // fresh cycle after this mute lifts
  await saveRow(db, row);
  return { kind: "spam_muted", name, until, label };
}
