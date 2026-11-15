/**
 * Provider-agnostic Intent Engine contract.
 *
 * Business logic (the WhatsApp bot pipeline) depends ONLY on this file —
 * never on a specific provider's SDK. This is the last-resort fallback
 * stage, reached only when rule-based detection (greeting/menu/status/FAQ/
 * pg_trgm/rate-limit/flood/duplicate checks) can't determine intent with
 * high confidence on its own.
 *
 * The classifier must NEVER be a single point of failure: if it's
 * unavailable, times out, or returns something that fails validation,
 * callers get UNKNOWN_RESULT and the pipeline falls back to
 * forward-to-admin. The bot must keep working with the classifier
 * completely absent.
 */

export type Intent =
  | "STUDENT_SUPPORT"
  | "GREETING"
  | "THANK_YOU"
  | "GOODBYE"
  | "MENU_REQUEST"
  | "STATUS_REQUEST"
  | "RANDOM_CONVERSATION"
  | "PERSONAL_CONVERSATION"
  | "SPAM"
  | "ABUSE"
  | "GIBBERISH"
  | "DUPLICATE_MESSAGE"
  | "UNKNOWN";

export interface IntentResult {
  intent: Intent;
  /** 0–1. Callers should treat low-confidence results as UNKNOWN even if
   *  the intent field itself parsed fine — see CONFIDENCE_THRESHOLD. */
  confidence: number;
  reason: string;
  next_action: string;
}

export interface ClassifyContext {
  studentId?: string;
  /** Short window only (last 2-3 messages) — never the full conversation
   *  history. Keeps prompt size and cost bounded. */
  recentMessages?: string[];
}

export interface IntentClassifier {
  readonly providerName: string;
  classify(message: string, context?: ClassifyContext): Promise<IntentResult>;
}

/** Returned whenever no provider is available/healthy/valid. Callers never
 *  special-case "the classifier is down" — they just get this and forward
 *  to admin, same as any other UNKNOWN. */
export const UNKNOWN_RESULT: IntentResult = {
  intent: "UNKNOWN",
  confidence: 0,
  reason: "classifier_unavailable",
  next_action: "forward_to_admin",
};

/** Below this, treat a parsed result as UNKNOWN regardless of what intent
 *  it claims — an LLM being confidently wrong is worse than it admitting
 *  uncertainty. Tune this once real classification logs exist. */
export const CONFIDENCE_THRESHOLD = 0.6;
