/**
 * Never hand a student half a sentence.
 *
 * A chat model that stops because it ran out of output tokens (finish_reason
 * "length" on OpenAI-style APIs, "MAX_TOKENS" on Gemini) leaves its reply cut
 * off mid-word. Found in real in-app threads (2026-10-10): "...reach out to the
 * support team through the", "You can see this", "...and the fee is ₹1100). To".
 *
 * Reasoning models make it routine. Groq's openai/gpt-oss-120b spends hidden
 * reasoning tokens out of the SAME max_tokens budget as the visible reply
 * (Groq docs: reasoning is "part of the token output"), so a 300-token cap
 * could be nearly all thinking and leave room for a handful of words. The same
 * bug class as the vision path, now on chat.
 *
 * The providers raise the budget and ask for low reasoning effort; this is the
 * safety net for whatever still gets cut: a truncated reply is trimmed back to
 * its last finished sentence, or — if there is none worth sending — treated as
 * "this provider could not answer" so the next one is tried.
 */

const MIN_USEFUL = 20;
const CLOSERS = /["')\]”’]/;

/**
 * `text` as the student should see it, or null when it should not be shown.
 * Not truncated → the text unchanged (trimmed). Truncated → cut back to the
 * last complete sentence (a ".", "!", "?" or Devanagari/Telugu danda that ends
 * a word), keeping any closing quote or bracket.
 */
export function completeAnswer(text: string, truncated: boolean): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (!truncated) return t;
  for (let i = t.length - 1; i >= 0; i--) {
    const c = t[i];
    if (c !== "." && c !== "!" && c !== "?" && c !== "।") continue;
    // "1.5", "e.g.x", "a.b" are not the end of a sentence.
    const next = t[i + 1];
    if (next !== undefined && !/\s/.test(next) && !CLOSERS.test(next)) continue;
    // "1." / "2." list numbering is not the end of a sentence either.
    const lineStart = t.lastIndexOf("\n", i) + 1;
    if (c === "." && /^\s*\d{1,2}\.$/.test(t.slice(lineStart, i + 1))) continue;
    let end = i + 1;
    while (end < t.length && CLOSERS.test(t[end])) end++;
    const cut = t.slice(0, end).trim();
    return cut.length >= MIN_USEFUL ? cut : null;
  }
  return null;
}

/**
 * Words a finished sentence does not end on. A reply with no closing
 * punctuation whose last word is one of these was cut off — whichever provider
 * produced it and whether or not that provider reported why it stopped.
 * Deliberately excludes words that can end a complete reply ("you" in
 * "thank you", "it", "no", "ok").
 */
const DANGLING = new Set([
  "the", "a", "an", "to", "of", "for", "in", "on", "at", "by", "with", "through", "from", "into",
  "about", "and", "or", "but", "if", "as", "than", "that", "this", "these", "those", "your", "my",
  "our", "their", "its", "his", "her", "is", "are", "was", "were", "be", "can", "could", "will",
  "would", "should", "may", "might", "must", "do", "does", "did", "not", "also", "then", "so",
  "because", "which", "who", "whom", "when", "where", "while", "how", "what", "why", "please",
]);

/** True when the text stops without closing punctuation on a word no sentence ends with. */
export function endsMidSentence(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  // Closing punctuation, a closing quote/bracket, a digit or an emoji all end a reply.
  if (/[.!?।…:;)\]"'”’0-9☀-➿\u{1F300}-\u{1FAFF}]$/u.test(t)) return false;
  const last = t.split(/\s+/).pop()!.toLowerCase().replace(/[^a-z']/g, "");
  return DANGLING.has(last);
}
