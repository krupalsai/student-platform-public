/**
 * Payment-screenshot OCR — extracts the UTR / amount from a UPI payment
 * screenshot to ASSIST an admin's manual verification. It never approves or
 * changes anything: the endpoint that uses this only reads, and the admin
 * still approves/rejects by hand. This just surfaces "the screenshot says UTR
 * X for ₹Y" and whether that matches what the student typed and the batch fee.
 *
 * Uses the shared vision caller (src/lib/vision.ts) — Gemini primary, Groq
 * secondary. Returns null on any failure (no key, unsupported model,
 * network/timeout, bad JSON) so the feature degrades to "not available"
 * instead of erroring.
 */

import { callVision, parseVisionJson } from "@/lib/vision";

export interface ExtractedPayment {
  utr: string | null;
  amount: number | null;
  app: string | null;
  status: string | null;
}

function coerce(parsed: any): ExtractedPayment {
  const utrRaw = parsed?.utr ?? parsed?.UTR ?? parsed?.transaction_id ?? parsed?.reference ?? null;
  const amtRaw = parsed?.amount ?? parsed?.Amount ?? null;
  const amount = amtRaw == null ? null : Number(String(amtRaw).replace(/[^0-9.]/g, ""));
  return {
    utr: utrRaw == null ? null : String(utrRaw).trim(),
    amount: amount != null && Number.isFinite(amount) ? amount : null,
    app: parsed?.app ? String(parsed.app).trim() : null,
    status: parsed?.status ? String(parsed.status).trim() : null,
  };
}

/**
 * Sends the screenshot (by URL — Groq fetches it) to a Groq vision model and
 * returns the extracted payment fields, or null if extraction wasn't possible.
 */
export async function extractPaymentFromImage(imageUrl: string): Promise<ExtractedPayment | null> {
  const text = await callVision({
    label: "payment-ocr",
    imageUrl,
    maxTokens: 300,
    prompt:
      "This is a screenshot of a UPI payment (Google Pay / PhonePe / Paytm / BHIM etc). " +
      "Read it and return ONLY a JSON object with these keys:\n" +
      "  utr: the UTR / UPI transaction ID / reference number (usually a 12-digit number), or null if not visible\n" +
      "  amount: the rupee amount paid, as a plain number (no ₹ or commas), or null\n" +
      "  app: which app it is (e.g. \"Google Pay\", \"PhonePe\", \"Paytm\"), or null\n" +
      "  status: the payment status shown (e.g. \"Completed\", \"Success\", \"Failed\"), or null\n" +
      "Do not guess — use null for anything you cannot clearly read. Return only the JSON.",
  });
  if (!text) return null;
  try {
    return coerce(parseVisionJson(text));
  } catch {
    console.error("[payment-ocr] vision model returned non-JSON:", text.slice(0, 500).replace(/\s+/g, " "));
    return null;
  }
}

/** Alphanumeric-only, uppercased — for tolerant UTR comparison. */
export function normalizeUtr(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
