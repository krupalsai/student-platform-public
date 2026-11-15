/**
 * Stall-promise guard for grounded LLM answers.
 *
 * Live failure, 2026-10-26: the owner asked the WhatsApp bot
 * "Did she paid" about a student and the bot replied "Let me check her
 * records." — a promise to check something, with no follow-through and
 * no answer. The bot can never "check later": it has one shot at the
 * reply, so a promise-to-check is a dead end the admin reads as the bot
 * working on it. Any grounded answer that is only such a promise must be
 * treated as no answer at all, so the caller falls through to its honest
 * path instead (admin → HELP, student → escalation to a human).
 *
 * Pure and dependency-free, so it runs under plain `node --test`.
 */

/** Phrases that promise a check the bot will never perform. */
const STALL_PATTERNS: RegExp[] = [
  /let me check\b/i,
  /let me look\b/i,
  /let me see\b/i,
  /let me find out\b/i,
  /let me verify\b/i,
  /\bi(?:'ll| will) check\b/i,
  /\bi(?:'ll| will) look into\b/i,
  /\bi(?:'ll| will) look it up\b/i,
  /\bi(?:'ll| will) get back\b/i,
  /\bi(?:'ll| will) verify\b/i,
  /\bi(?:'m| am) checking\b/i,
  /\bchecking (?:on |into )?(?:that|this|it|your|her|his|their|the)\b/i,
  /\bgive me a (?:moment|minute)\b.{0,50}\bcheck\b/i,
];

/** Filler that carries no fact once the promise itself is removed. */
const FILLER: RegExp[] = [
  /\b(?:if|whether)\b[^.!?;]*/gi,
  /\band get back to you\b/gi,
  /\bget back to you\b/gi,
  /\bher records\b/gi,
  /\bhis records\b/gi,
  /\btheir records\b/gi,
  /\byour records\b/gi,
  /\bthe records\b/gi,
  /\bfor you\b/gi,
  /\bwith the team\b/gi,
  /\blet you know\b/gi,
  /\band let you know\b/gi,
];

/**
 * Signals that what remains actually delivers an answer: an amount, a
 * date, a phone number, or a status verdict about a specific student.
 * Checked only on the text left after the promise and its filler are
 * stripped, so "let me check if she paid" does not count — "paid" there
 * is a conditional, not a verdict.
 */
const ANSWER_SIGNALS: RegExp[] = [
  /₹|\brs\.?\s?\d|\binr\s?\d/i,
  /\bpaid\b/i,
  /\bnot registered\b/i,
  /\bregistered\b/i,
  /\bapproved\b/i,
  /\bpending\b/i,
  /\bfailed\b/i,
  /\brejected\b/i,
  /\b\d{1,2}\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /(?:\+?91[\s-]?)?[6-9]\d{9}\b/,
];

/**
 * True when the whole reply is a promise to check something, with no
 * answer delivered alongside it. A reply that also states a fact
 * (amount, status, date) is not a stall.
 */
export function isStallPromise(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (!STALL_PATTERNS.some((re) => re.test(t))) return false;

  // Strip the promise, its conditionals and its filler; what is left
  // must carry a concrete fact to count as an answer.
  let rest = t;
  for (const re of STALL_PATTERNS) rest = rest.replace(new RegExp(re.source, "gi"), " ");
  for (const re of FILLER) rest = rest.replace(re, " ");
  // An admission of not knowing is checked before punctuation is
  // stripped ("don't" would otherwise become "don t").
  const admission = /^(?:i don't|i do not|i can't|i cannot|unable|sorry)\b/i.test(rest.trim());
  rest = rest.replace(/[^\w\s₹]/g, " ").replace(/\s+/g, " ").trim();
  if (!rest) return true;
  // A concrete fact survives: amount, date, phone, or status verdict.
  if (ANSWER_SIGNALS.some((re) => re.test(rest))) return false;
  // An admission of not knowing ("I don't have that detail") is honest
  // but is not an answer — with a stall promise attached, escalate.
  if (admission) return true;
  // A short generic remainder is just the promise restated.
  if (rest.split(/\s+/).length <= 4) return true;
  // Anything longer with no stall-only shape: give the answer the
  // benefit of the doubt and do not filter it.
  return false;
}
