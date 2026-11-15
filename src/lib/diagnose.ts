/**
 * Self-diagnose engine — one shared diagnosis used by BOTH the in-app
 * "App not working?" check (/api/diagnose) and the WhatsApp bot
 * ("app not working" reports), so a student gets the same answer and the
 * same one-tap fix whichever way they ask.
 *
 * Why this exists (14 Nov 2026): students walk up to Krupal in person
 * saying "app is not working" and nobody knows what is wrong. The bot's
 * fix-guide only understood OTP / not-registered / clear-data, so a
 * generic report fell through to the AI brain (down since 17-18 Oct) and
 * then to "ask inside the Student App" — the very app that wasn't
 * working. This module answers from the student's OWN record instead:
 * profile, registration, batch, payment, recent client errors on their
 * phone, and known live server breakage.
 *
 * Rules:
 * - Only ever describes the caller's own record (looked up by their own
 *   phone). No amounts, no transaction refs, no other student's data.
 * - Never invents a cause. When nothing in the record explains the
 *   report, the answer is "unknown" and a ticket is filed — never a guess.
 * - A fix is only offered when it is a real action for this student.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { findStudentByPhone, normalizePhone } from "@/lib/services/students";
import { getRegistrationStatus } from "@/lib/services/registration";
import { getPaymentStatus } from "@/lib/services/payments";
import { getBatchStatus } from "@/lib/services/batches";
import { buildRegisterLink, buildVerifyLink } from "@/lib/app-login";

export type DiagnoseFixKind =
  | "verify_code"
  | "open_app"
  | "register"
  | "resume_registration"
  | "retry_payment"
  | "reupload_id"
  | "clear_data"
  | "wait_server"
  | "ticket";

export interface DiagnoseFix {
  kind: DiagnoseFixKind;
  /** Button label, plain words. */
  label: string;
  /** One-tap URL when the fix is a link; null when the fix is steps. */
  url: string | null;
  /** One short instruction shown under the button (or the whole fix). */
  note: string;
}

export interface Diagnosis {
  /** Machine key, also stored on the ticket so the team can count causes. */
  issue: string;
  /** One plain-language line: what is wrong. */
  title: string;
  /** One or two short sentences: why, and what happens next. */
  detail: string;
  fix: DiagnoseFix;
  /** True when a human still needs to look at this. */
  needsTicket: boolean;
  studentFound: boolean;
  /** Facts attached to the ticket / escalation — never shown to other students. */
  context: {
    phone: string;
    name: string | null;
    batch: string | null;
    paymentStatus: string | null;
    clientError: string | null;
    serverBreakage: string | null;
  };
}

export interface DiagnoseHints {
  /** What the student typed / which screen they said they are stuck on. */
  screen?: string | null;
  /** Client-side error text, if the app reported one. */
  error?: string | null;
}

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://studentplatform.dev").replace(/\/$/, "");

function appLink(next: string): string {
  return `${APP_URL}/install?next=${encodeURIComponent(next)}`;
}

const COURT_CASE_ROUTE = "court-case/getBatchCaseStatus";
const COURT_CASE_MESSAGE = "live refresh failed, serving stale cache";

async function recentClientError(db: SupabaseClient, studentId: string): Promise<string | null> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await db
      .from("system_errors")
      .select("route, message, created_at")
      .eq("meta->>student_id", studentId)
      .like("route", "client/%")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = (data ?? [])[0] as { route: string; message: string } | undefined;
    return row ? `${row.route}: ${row.message}` : null;
  } catch {
    return null;
  }
}

async function recentCourtCaseFailure(db: SupabaseClient): Promise<boolean> {
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data } = await db
      .from("system_errors")
      .select("id")
      .eq("route", COURT_CASE_ROUTE)
      .eq("message", COURT_CASE_MESSAGE)
      .gte("created_at", since)
      .limit(1);
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

function mentions(haystack: string | null | undefined, words: string[]): boolean {
  const t = (haystack ?? "").toLowerCase();
  return words.some((w) => t.includes(w));
}

/**
 * Diagnose one student by phone. Never throws: on any lookup failure the
 * answer is "unknown" with a ticket, so the student is never left with a
 * crash or a blank screen.
 */
export async function diagnoseStudent(
  db: SupabaseClient,
  rawPhone: string,
  hints: DiagnoseHints = {},
): Promise<Diagnosis> {
  const phone = normalizePhone(rawPhone);
  const hintText = `${hints.screen ?? ""} ${hints.error ?? ""}`;
  const base = (d: Partial<Diagnosis> & Pick<Diagnosis, "issue" | "title" | "detail" | "fix">): Diagnosis => ({
    needsTicket: false,
    studentFound: false,
    context: { phone, name: null, batch: null, paymentStatus: null, clientError: null, serverBreakage: null },
    ...d,
  });

  try {
    const student = await findStudentByPhone(db, phone).catch(() => null);

    // 1. No profile for this number — no code can ever arrive for it, and
    //    no payment or batch can exist. Registration is the only fix.
    if (!student) {
      const registerUrl = await buildRegisterLink().catch(() => null);
      return base({
        issue: "not_registered",
        title: "This number is not registered yet.",
        detail:
          "There is no student account for this mobile number, so the app has nothing to sign you into. Register first — it takes a minute on WhatsApp.",
        fix: {
          kind: "register",
          label: "Register on WhatsApp",
          url: registerUrl,
          note: registerUrl
            ? "Tap and reply Register to the bot to get your registration link."
            : "Message the Student Platform WhatsApp bot and reply Register.",
        },
      });
    }

    const name = (student as { full_name?: string | null }).full_name ?? null;
    const batchName =
      (student as { batches?: { name?: string | null } | null }).batches?.name ?? null;
    const ctx: Diagnosis["context"] = {
      phone,
      name,
      batch: batchName,
      paymentStatus: null,
      clientError: null,
      serverBreakage: null,
    };
    const withCtx = (d: Partial<Diagnosis> & Pick<Diagnosis, "issue" | "title" | "detail" | "fix">): Diagnosis => ({
      ...base(d),
      studentFound: true,
      context: ctx,
    });

    // 2. The student said the code is not coming — the fix is a fresh code
    //    on WhatsApp, not another push attempt. (Checked before the record
    //    checks below: the symptom was stated, and the fix is the same
    //    whether or not the record also has another problem.)
    if (mentions(hintText, ["otp", "code", "verification", "login code", "didn't arrive", "didnt arrive", "not coming", "not received"])) {
      const verifyUrl = await buildVerifyLink().catch(() => null);
      return withCtx({
        issue: "otp_not_arriving",
        title: "Your login code is not arriving as a notification.",
        detail:
          "The code is sent as a phone notification, and that delivery sometimes fails. WhatsApp always works — get the code there and type it in the app.",
        fix: {
          kind: "verify_code",
          label: "Get code on WhatsApp",
          url: verifyUrl,
          note: verifyUrl
            ? "Tap, send VERIFY, and type the 6-digit code the bot replies with into the app."
            : "Message VERIFY to the Student Platform WhatsApp bot and type the code it replies with into the app.",
        },
      });
    }

    // 3. Registration started but never finished.
    const registration = await getRegistrationStatus(db, student.id).catch(() => null);
    if (registration && !registration.isComplete) {
      return withCtx({
        issue: "registration_incomplete",
        title: "Your registration is not finished yet.",
        detail:
          "Your account exists but registration was left halfway, so the app cannot let you in. Open the app and finish the remaining step.",
        fix: {
          kind: "resume_registration",
          label: "Open the app to finish registration",
          url: appLink("/login"),
          note: "Sign in with your number and complete the step the app shows you.",
        },
      });
    }

    // 4. No College ID photo on the profile.
    const collegeIdPath = (student as { college_id_path?: string | null }).college_id_path ?? null;
    if (!collegeIdPath) {
      return withCtx({
        issue: "id_missing",
        title: "Your College ID photo is missing.",
        detail:
          "Registration needs a photo of your College ID card. Without it your account stays incomplete and the app cannot move forward.",
        fix: {
          kind: "reupload_id",
          label: "Upload your College ID",
          url: appLink("/login"),
          note: "Open the app and upload your College ID photo. If your card has no signature on it, sign on a blank paper, keep it next to the card, and photograph both together.",
        },
      });
    }

    // 5. Batch is closed or not active yet — only a human can move the student.
    const batchId = (student as { batch_id?: string | null }).batch_id ?? null;
    if (batchId) {
      const batch = await getBatchStatus(db, batchId).catch(() => null);
      if (batch && batch.status === "closed") {
        return withCtx({
          issue: "batch_closed",
          title: `Your batch (${batch.name}) is closed.`,
          detail:
            "Your batch has ended, so the app has nowhere to place you right now. This has been reported — the team will move you to the next batch. No need to message anyone.",
          fix: {
            kind: "ticket",
            label: "Reported — we will move you to the next batch",
            url: null,
            note: "You don't need to do anything else. We will message you when you are moved.",
          },
          needsTicket: true,
        });
      }
      if (batch && batch.status === "pending_setup") {
        return withCtx({
          issue: "batch_not_active",
          title: `Your batch (${batch.name}) is not active yet.`,
          detail:
            "Your batch is set up but not opened yet, so the app cannot let you in. This has been reported — the team will open it. No need to message anyone.",
          fix: {
            kind: "ticket",
            label: "Reported — we will open your batch",
            url: null,
            note: "You don't need to do anything else. We will message you when your batch opens.",
          },
          needsTicket: true,
        });
      }
    }

    // 6. Payment state — a failed, pending or missing payment is the most
    //    common reason the Pay button looks dead.
    const payment = await getPaymentStatus(db, student.id).catch(() => null);
    if (payment) {
      ctx.paymentStatus = payment.status;
      if (payment.status === "failed") {
        return withCtx({
          issue: "payment_failed",
          title: "Your payment did not go through.",
          detail:
            "Your last payment attempt failed, so the app still shows you as unpaid. Try paying again from the app.",
          fix: {
            kind: "retry_payment",
            label: "Open the app and pay again",
            url: appLink("/login"),
            note: "Sign in and tap Pay. If money was deducted, keep the UPI reference — the team can check it.",
          },
        });
      }
      if (payment.status === "pending") {
        return withCtx({
          issue: "payment_pending",
          title: "Your payment is still showing as pending.",
          detail:
            "Your payment was started but has not been confirmed yet. Open the app and check — if it stays pending, this report is already saved for the team.",
          fix: {
            kind: "retry_payment",
            label: "Open the app to check your payment",
            url: appLink("/login"),
            note: "Sign in and open your payment status. Do not pay twice until the pending one is confirmed or fails.",
          },
        });
      }
      if (payment.status === "none") {
        return withCtx({
          issue: "payment_missing",
          title: "No payment is recorded for you yet.",
          detail:
            "Your registration needs the batch fee before the app can let you in. Open the app and pay the fee shown there.",
          fix: {
            kind: "retry_payment",
            label: "Open the app and pay",
            url: appLink("/login"),
            note: "Sign in and tap Pay. Pay only the amount the app shows.",
          },
        });
      }
    }

    // 7. This phone itself recently reported a crash / stuck cover / reload
    //    loop — the phone's saved app data is the problem, not the account.
    const clientError = await recentClientError(db, student.id);
    if (clientError) {
      ctx.clientError = clientError;
      return withCtx({
        issue: "app_crashing",
        title: "The app is crashing or stuck on your phone.",
        detail:
          "Your phone recently reported the app freezing or reloading itself. Your account is fine — the saved app data on this phone needs clearing, then sign in again.",
        fix: {
          kind: "clear_data",
          label: "Fix it — clear the stuck login and sign in again",
          url: appLink("/fix"),
          note: "Tap the button — it clears the stuck login on this phone and opens a fresh sign in. Or, in Chrome, open studentplatform.dev/fix and tap Fix my app.",
        },
      });
    }

    // 8. Known live server breakage: the High Court case-status lookup has
    //    been failing, so case pages show the last saved status. The student
    //    sees old case info and reasonably reports "app not working".
    //    Nothing they can tap fixes this — it is already being tracked.
    if (await recentCourtCaseFailure(db)) {
      ctx.serverBreakage = `${COURT_CASE_ROUTE}: ${COURT_CASE_MESSAGE}`;
      return withCtx({
        issue: "case_status_stale",
        title: "The case status shown in the app is out of date.",
        detail:
          "The court's own case-status page is not answering right now, so the app is showing the last status it saved. Your account, payment and registration are all fine. This has been reported — no need to message anyone.",
        fix: {
          kind: "wait_server",
          label: "Reported — the case status will refresh itself",
          url: null,
          note: "Nothing to do on your phone. Check the case status again later — it updates on its own once the court's page answers.",
        },
        needsTicket: true,
      });
    }

    // 9. Nothing in the record explains it. Say so, file it, don't guess.
    return withCtx({
      issue: "unknown",
      title: "We could not find what is wrong from your account.",
      detail:
        "Your registration, batch and payment all look fine, and your phone reported no crash — so this needs a human to look at it. It has been reported with your details. No need to message anyone.",
      fix: {
        kind: "ticket",
        label: "Reported — we are looking into it",
        url: null,
        note: "You don't need to do anything else. We will message you when it is fixed.",
      },
      needsTicket: true,
    });
  } catch (e) {
    console.error("[diagnose] failed, returning unknown:", (e as Error).message);
    return base({
      issue: "unknown",
      title: "We could not check your account just now.",
      detail:
        "The check itself failed, so this has been reported with your number. No need to message anyone.",
      fix: {
        kind: "ticket",
        label: "Reported — we are looking into it",
        url: null,
        note: "You don't need to do anything else. We will message you when it is fixed.",
      },
      needsTicket: true,
    });
  }
}

/**
 * File a diagnose report as a support thread (the existing
 * student_queries + student_query_messages model — no new table).
 * Dedupes: an already-open technical ticket for this student from the
 * last 24h is reused instead of opening a second one for the same
 * problem. Returns the thread id, or null when the insert failed.
 */
export async function fileDiagnoseTicket(
  db: SupabaseClient,
  opts: {
    studentId: string | null;
    phone: string;
    name: string | null;
    batchId: string | null;
    college: string | null;
    diagnosis: Diagnosis;
    screen?: string | null;
    error?: string | null;
    source: "student_app" | "whatsapp";
  },
): Promise<string | null> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (opts.studentId) {
      const { data: existing } = await db
        .from("student_queries")
        .select("id")
        .eq("student_id", opts.studentId)
        .eq("category", "technical")
        .eq("status", "open")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1);
      if ((existing ?? [])[0]?.id) return (existing as { id: string }[])[0].id;
    }

    const d = opts.diagnosis;
    const lines = [
      `[diagnose:${d.issue}] App not working — auto-diagnosis`,
      `Student: ${opts.name ?? "unknown"} (+${opts.phone})`,
      `Diagnosis: ${d.title}`,
      `Detail: ${d.detail}`,
      `Batch: ${d.context.batch ?? "—"} | Payment: ${d.context.paymentStatus ?? "—"}`,
      d.context.clientError ? `Phone error: ${d.context.clientError}` : null,
      d.context.serverBreakage ? `Server breakage: ${d.context.serverBreakage}` : null,
      opts.screen ? `Student said: ${opts.screen}` : null,
      opts.error ? `App error: ${String(opts.error).slice(0, 300)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const message = lines.slice(0, 1900);

    const { data: row, error } = await db
      .from("student_queries")
      .insert({
        student_id: opts.studentId,
        name: opts.name,
        message,
        batch_id: opts.batchId,
        college: opts.college,
        last_message_at: new Date().toISOString(),
        last_sender: "student",
        source: opts.source,
        category: "technical",
        priority: "high",
        status: "open",
      })
      .select("id")
      .single();
    if (error || !row) {
      console.error("[diagnose] ticket insert failed:", error?.message);
      return null;
    }
    await db.from("student_query_messages").insert({
      query_id: (row as { id: string }).id,
      sender: "student",
      author_id: opts.studentId,
      body: message,
    });
    return (row as { id: string }).id;
  } catch (e) {
    console.error("[diagnose] ticket filing failed:", (e as Error).message);
    return null;
  }
}
