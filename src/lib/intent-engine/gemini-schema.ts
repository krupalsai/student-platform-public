import { z } from "zod";
import type { Intent } from "./types";

/** Keep this list in sync with the Intent union in ./types. Zod needs its
 *  own literal tuple — it can't derive one from a TS type at runtime. */
export const INTENT_VALUES = [
  "STUDENT_SUPPORT",
  "GREETING",
  "THANK_YOU",
  "GOODBYE",
  "MENU_REQUEST",
  "STATUS_REQUEST",
  "RANDOM_CONVERSATION",
  "PERSONAL_CONVERSATION",
  "SPAM",
  "ABUSE",
  "GIBBERISH",
  "DUPLICATE_MESSAGE",
  "UNKNOWN",
] as const satisfies readonly Intent[];

export const IntentResultSchema = z.object({
  intent: z.enum(INTENT_VALUES),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(300),
  next_action: z.string().min(1).max(100),
});

/** Gemini's `responseSchema` (its own JSON-Schema-like format, not Zod) —
 *  passed in generationConfig so the model is constrained at generation
 *  time, not just validated after the fact. Zod above is the real gate;
 *  this just makes malformed output less likely in the first place. */
export const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: INTENT_VALUES as unknown as string[] },
    confidence: { type: "number" },
    reason: { type: "string" },
    next_action: { type: "string" },
  },
  required: ["intent", "confidence", "reason", "next_action"],
} as const;
