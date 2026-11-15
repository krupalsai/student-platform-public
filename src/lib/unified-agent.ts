/**
 * Unified Agent — ONE shared brain for the Student Platform, three doors.
 *
 * Doors that call this module (and nothing else for the steps below):
 *   1. Student in-app support — src/app/api/support/route.ts (replyAsBot)
 *   2. Admin in-app copilot — src/app/api/admin/copilot/route.ts
 *      (respondWithAction, through prepareUnifiedAdminAction)
 *   3. WhatsApp bot text — src/lib/whatsapp/router.ts
 *      (answerWithAiFirst + handleFreeTextQuestion, reply-only)
 * Voice / call-brain routes are deliberately NOT changed by this module.
 *
 * Rules this module enforces, wherever it is called from:
 * - A student only ever sees their OWN record. The snapshot is built from
 *   the authenticated session profileId, or from the phone-linked profile
 *   on WhatsApp — never from an id, phone or name typed in the message.
 *   A message naming a different student's phone is refused, with no
 *   data about that other student looked up or leaked.
 * - Fees are read live from the batch (via the student snapshot's payment
 *   gate, which reads the batch row). No fee is ever hardcoded here.
 *   On WhatsApp no rupee amount is ever returned (rule 8): the amount is
 *   shown in the Student App Payments tab only.
 * - Admin writes NEVER execute here. They go through the existing
 *   prepareAction / executeAction confirmation flow (HMAC 10-minute
 *   token, role gates, audit log). This module only re-checks the role
 *   gates before delegating, so a caller cannot bypass them by importing
 *   this module instead of admin-copilot-agent.
 * - No new environment variables, no new paid keys. FAQ grounding and
 *   the snapshot are deterministic / already-paid-for paths; any LLM
 *   step stays in the callers' existing free-provider chains. When a
 *   lookup fails, this module returns handled: false and the caller
 *   falls back to its existing grounded-LLM / escalation path — it
 *   never invents a case number, fee, or student record.
 *
 * The heavy imports (snapshot, FAQ, admin actions) are dynamic, so the
 * pure helpers (in unified-agent-pure.ts: isOwnStatusQuestion,
 * extractOtherStudentPhone, formatOwnStatus) can be unit-tested
 * without a database or LLM key.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminAction } from "./admin-copilot-agent";
import type { StudentSnapshot } from "./services/student-snapshot";
import {
  isAdminRole,
  assertUnifiedAdminActor,
  isOwnStatusQuestion,
  extractOtherStudentPhone,
  formatOwnStatus,
} from "./unified-agent-pure";

export type { UnifiedChannel, UnifiedActor, UnifiedStudentSnapshot } from "./unified-agent-pure";
export {
  isAdminRole,
  assertUnifiedAdminActor,
  isOwnStatusQuestion,
  unifiedLocalPhone,
  extractMentionedPhones,
  extractOtherStudentPhone,
  formatOwnStatus,
} from "./unified-agent-pure";
import type { UnifiedActor, UnifiedChannel } from "./unified-agent-pure";

export interface UnifiedAnswer {
  handled: boolean;
  answer: string;
  /** Which deterministic step handled it — never an LLM provider name. */
  source: "own-status" | "faq" | "other-student-refusal" | "admin-guard" | "none";
}

const DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  "archive_batch",
  "delete_student",
]);

/**
 * Shared admin write gate. Delegates to the existing prepareAction —
 * which issues the HMAC confirmation token and audit-logs — and never
 * executes anything itself. A caller must still present the token via
 * executeUnifiedAdminAction (or executeAction) to actually run it.
 */
export async function prepareUnifiedAdminAction(
  db: SupabaseClient,
  action: AdminAction,
  actor: UnifiedActor,
): Promise<{ ok: boolean; message?: string; confirmation?: string; token?: string }> {
  const guard = assertUnifiedAdminActor(actor);
  if (guard) return { ok: false, message: guard };
  if (DESTRUCTIVE_ACTIONS.has(action.name) && actor.role !== "super_admin") {
    return { ok: false, message: "Only Super Admin can perform that destructive action." };
  }
  const { prepareAction } = await import("./admin-copilot-agent");
  const prepared = (await prepareAction(db, action, {
    profileId: actor.profileId ?? "",
    role: actor.role,
  })) as { ok: boolean; message?: string; confirmation?: string; token?: string };
  return prepared;
}

/** Executes ONLY a previously issued confirmation token, via the existing flow. */
export async function executeUnifiedAdminAction(
  db: SupabaseClient,
  token: string,
  actor: UnifiedActor,
): Promise<{ ok: boolean; message: string }> {
  const guard = assertUnifiedAdminActor(actor);
  if (guard) return { ok: false, message: guard };
  const { executeAction } = await import("./admin-copilot-agent");
  return executeAction(db, token, {
    profileId: actor.profileId ?? "",
    role: actor.role,
  });
}

/* ------------------------------------------------------------------ */
/* Student agent — the shared step used by all three doors             */
/* ------------------------------------------------------------------ */

export async function runUnifiedStudentAgent(
  db: SupabaseClient,
  actor: UnifiedActor,
  question: string,
  opts: { snapshot?: StudentSnapshot | null } = {},
): Promise<UnifiedAnswer> {
  const none: UnifiedAnswer = { handled: false, answer: "", source: "none" };
  if (isAdminRole(actor.role)) return none;
  const channel: UnifiedChannel = actor.channel ?? "app";

  // Resolve the sender's own profile: session first, phone link second.
  // Nothing here ever trusts an id typed in the message.
  let profileId = actor.profileId ?? null;
  let ownPhone: string | null = actor.phone ?? null;
  if (!profileId && actor.phone) {
    try {
      const { findStudentByPhone } = await import("./services/students");
      const student = await findStudentByPhone(db, actor.phone).catch(() => null);
      profileId = (student as { id?: string } | null)?.id ?? null;
      ownPhone = (student as { phone?: string } | null)?.phone ?? ownPhone;
    } catch {
      return none;
    }
  }
  if (!profileId) return none;

  // Other-student guard — before any status or FAQ work, and with no
  // lookup of the other number. The refusal names no other student.
  if (extractOtherStudentPhone(question, [ownPhone])) {
    return {
      handled: true,
      answer:
        "I can only help with your own registration and payment, so I can't share or check anyone else's details. They can message from their own phone, or use the Student App signed in as themselves.",
      source: "other-student-refusal",
    };
  }

  // Deterministic own-status first: cheapest, most authoritative, no LLM.
  if (isOwnStatusQuestion(question)) {
    try {
      const snapshot =
        opts.snapshot ??
        (await (await import("./services/student-snapshot")).buildStudentSnapshot(db, profileId));
      return { handled: true, answer: formatOwnStatus(snapshot, channel), source: "own-status" };
    } catch {
      return none;
    }
  }

  // FAQ / RAG grounding second — same corpus the support bot uses.
  try {
    const { searchFaq } = await import("./services/faq");
    const match = await searchFaq(db, question).catch(() => null);
    if (match) return { handled: true, answer: match.answer, source: "faq" };
  } catch {
    return none;
  }
  return none;
}

/** WhatsApp entry point: sender is identified by phone, reply-only. */
export async function runUnifiedStudentAgentByPhone(
  db: SupabaseClient,
  phone: string,
  question: string,
): Promise<UnifiedAnswer> {
  try {
    const { findStudentByPhone } = await import("./services/students");
    const student = await findStudentByPhone(db, phone).catch(() => null);
    if (!student) return { handled: false, answer: "", source: "none" };
    return runUnifiedStudentAgent(
      db,
      { role: "student", profileId: (student as { id: string }).id, phone, channel: "whatsapp" },
      question,
    );
  } catch {
    return { handled: false, answer: "", source: "none" };
  }
}
