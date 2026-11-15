/**
 * Shared "what is visibly in this photo" describer — the vision-analysis
 * half of image understanding, kept separate from HOW the image got
 * uploaded. `src/lib/whatsapp/image-understanding.ts` downloads from
 * WhatsApp's media API and calls this; `POST /api/support/image-describe`
 * (the in-app "Ask a Question" flow) uploads a browser file and calls this
 * same function — one prompt, one set of AI-boundary rules, two upload
 * paths in front of it.
 *
 * AI-boundaries guardrail: the model may describe what's visibly written
 * in the image (amount, reference number, an error message's text), but
 * must NEVER assert whether a payment succeeded/was approved or a document
 * is valid — that determination always comes from this platform's own
 * database (Section 1's "the bot only answers/guides/summarises, never
 * approves/invents policy" rule applies here exactly as it does to text).
 * A caller is expected to fold the returned description into the normal
 * grounded-answer pipeline (which already injects the student's REAL
 * payment status from Supabase) rather than treat it as authoritative on
 * its own.
 */

import { callVision, parseVisionJson } from "@/lib/vision";

export type ImageCategory =
  | "payment_screenshot"
  | "id_document"
  | "receipt_or_certificate"
  | "error_screenshot"
  | "other";

export interface ImageAnalysis {
  category: ImageCategory;
  description: string;
}

const PROMPT =
  "You are looking at a photo a college student sent to a support chatbot. Read it the way a careful " +
  "human would: notice every element on the page, not just the headline text.\n\n" +
  "1. RECOGNIZE — every piece of text (headings, labels, amounts, reference/transaction numbers, error " +
  "messages, names, dates), any diagram, table, chart, or structured layout, and any physical objects " +
  "(a card, a printed document, a phone screen, a handwritten note).\n" +
  "2. UNDERSTAND — what kind of thing this is overall (a payment screenshot, an error dialog, a college " +
  "ID, a receipt, a form, a diagram explaining a process, etc.) and how its parts relate to each other " +
  "(e.g. which label belongs to which value, what step of a flow a screenshot is showing).\n" +
  "3. REASON — in 2-5 sentences, explain what the image is actually telling the reader, in plain " +
  "language, referencing the specific text/numbers/layout you saw. If something on it is confusing or " +
  "contradictory, say what looks off and why, instead of just restating it as flat text.\n\n" +
  "IMPORTANT RULES:\n" +
  "- Ground every claim in what is literally visible — do not invent numbers, names, or outcomes that " +
  "aren't actually shown.\n" +
  "- Never state or imply whether a payment succeeded, was approved, or a document is valid/authentic — " +
  "you cannot know that from a photo alone; the platform's own records decide that, not you. You CAN " +
  "describe that a screen shows a 'success' or 'failed' message, as long as you're clear you're reporting " +
  "what the screen itself says, not confirming it against real records.\n" +
  "- If the image is blurry, unrelated to the platform, or you cannot read part of it clearly, say " +
  "exactly which part and why, rather than guessing.\n\n" +
  'Respond with ONLY this JSON shape, nothing else: {"category": "payment_screenshot" | "id_document" | ' +
  '"receipt_or_certificate" | "error_screenshot" | "other", "description": string}';

/**
 * Runs the shared vision provider (Gemini primary, Groq secondary — same
 * as every other vision call in this codebase) against an already-hosted
 * image URL and returns a description safe to fold into the normal text
 * pipeline. Fails soft (returns null) on any error — no vision key,
 * provider timeout, bad response — so a caller can always fall back to
 * "the image just doesn't get analyzed this time" with zero risk of
 * blocking whatever flow it's part of.
 */
export async function describeImage(imageUrl: string): Promise<ImageAnalysis | null> {
  try {
    const text = await callVision({ prompt: PROMPT, imageUrl, label: "image-understanding" });
    if (!text) return null;

    const parsed = parseVisionJson(text);
    const category: ImageCategory = [
      "payment_screenshot", "id_document", "receipt_or_certificate", "error_screenshot", "other",
    ].includes(parsed?.category) ? parsed.category : "other";
    const description = typeof parsed?.description === "string" && parsed.description.trim()
      ? parsed.description.trim()
      : null;
    if (!description) return null;

    return { category, description };
  } catch (e) {
    console.error("[image-understanding] analysis failed:", (e as Error).message);
    return null;
  }
}
