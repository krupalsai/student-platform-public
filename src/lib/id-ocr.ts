/**
 * College-ID photo check — flags likely problems for admin review.
 * The result is advisory only and never blocks an upload by itself.
 */

import { callVision, parseVisionJson } from "@/lib/vision";

export interface IdCheckResult {
  isIdCard: boolean;
  hasSignature: boolean;
  notes: string | null;
}

function coerce(parsed: any): IdCheckResult {
  return {
    isIdCard: parsed?.is_id_card === true,
    hasSignature: parsed?.has_signature === true,
    notes: parsed?.notes ? String(parsed.notes).trim().slice(0, 200) : null,
  };
}

export async function verifyCollegeId(imageUrl: string): Promise<IdCheckResult | null> {
  const text = await callVision({
    label: "id-ocr",
    imageUrl,
    maxTokens: 250,
    prompt:
      "Inspect this image as a college/institution student ID-card submission. The photograph may be rotated 90/180 degrees, " +
      "perspective-skewed, photographed at an angle, or contain surrounding paper/background. Mentally rotate and inspect the " +
      "ID card before deciding. Return ONLY JSON with these keys:\n" +
      "  is_id_card: true only when the main subject is clearly a student/college/institution ID card, otherwise false.\n" +
      "  has_signature: true when the student's own handwritten signature is visible ANYWHERE in the photo — either directly " +
      "on the ID card, or written on paper/background held or placed alongside the card in the same shot. Many institution ID " +
      "cards are rigid plastic badges with no space to sign, so students are instructed to sign on the surrounding paper next " +
      "to the card instead — that is the EXPECTED, VALID pattern, not a defect. Do not require a signature box, do not require " +
      "the mark to be on the card itself. Do NOT count a printed name, printed signature, seal, stamp, or a college official's " +
      "signature such as Director, Principal, HOD, Registrar, Authorized Signatory, as the student's own signature. Return " +
      "false ONLY when no genuine handwritten signature belonging to the student appears anywhere in the frame (card or " +
      "surrounding paper/background) after considering the rotated image.\n" +
      "  notes: one short sentence explaining the result. If the ID and student signature are clearly visible, use null. If " +
      "uncertain, say what is uncertain rather than claiming the signature is definitely absent.\n" +
      "Return only the JSON.",
  });
  if (!text) return null;
  try {
    return coerce(parseVisionJson(text));
  } catch {
    console.error(`[id-ocr] vision model returned non-JSON (len=${text.length}):`, JSON.stringify(text.slice(0, 500)));
    return null;
  }
}
