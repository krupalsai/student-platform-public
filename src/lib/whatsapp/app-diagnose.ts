/**
 * WhatsApp "app not working" handler — the bot side of the self-diagnose
 * system (14 Nov 2026). Same engine as the in-app check
 * (src/lib/diagnose.ts), same plain-language answer, same one-tap fix.
 *
 * Flow:
 * 1. Student reports the app is not working (any wording — English,
 *    Telugu, Tanglish — matched by matchAppProblem in fix-guide.ts).
 * 2. We diagnose from their record by phone straight away — no questions
 *    when the record already explains it.
 * 3. Only when the diagnosis is "unknown" do we ask ONE question: which
 *    screen are you stuck on? (buttons; the reply comes back as a menu
 *    selection). Their answer re-runs the diagnosis with that screen.
 * 4. If it still cannot be fixed, a support ticket is filed automatically
 *    and the student is told "Reported, we are fixing it" — they never
 *    need to find Krupal.
 * 5. Krupal is WhatsApped ONLY when it cannot be fixed AND a human must
 *    act for this student (unknown cause, batch closed / not active) —
 *    with the full diagnosis attached, never a bare "app not working".
 *    The known server breakage (court case-status lookup failing) is NOT
 *    escalated per student: the health-check's deterministic alert covers
 *    it once, and the ticket is the record.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { diagnoseStudent, fileDiagnoseTicket, type Diagnosis } from "@/lib/diagnose";
import { findStudentByPhone, normalizePhone } from "@/lib/services/students";
import { sendWhatsAppText, sendWhatsAppButtons, sendWhatsAppCtaButton } from "@/lib/whatsapp/client";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { buildRegisterLink, buildVerifyLink } from "@/lib/app-login";
import { sendFixFor } from "@/lib/whatsapp/fix-guide";
import { startIdReuploadFlow } from "@/lib/whatsapp/id-reupload";
import { savePending, loadPending, clearPending } from "@/lib/whatsapp/pending-slots";

const PENDING_INTENT = "app_problem";

/** Which screen the student's reply points at, or null when unclear. */
export function parseAppScreenReply(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (/^(1|login|log in|code|otp|sign in|signin)$/.test(t) || t.includes("login") || t.includes("code") || t.includes("otp")) {
    return "Login / code screen";
  }
  if (/^(2|after login|dashboard|home|inside)$/.test(t) || t.includes("after login") || t.includes("dashboard") || t.includes("home screen")) {
    return "After login — app opens but stuck";
  }
  if (/^(3|payment|pay|fee)$/.test(t) || t.includes("payment") || t.includes("pay")) {
    return "Payment screen";
  }
  if (/^(4|case|court|status)$/.test(t) || t.includes("case") || t.includes("court")) {
    return "Case status screen";
  }
  return null;
}

async function escalateToAdmins(
  db: SupabaseClient,
  phone: string,
  diagnosis: Diagnosis,
  ticketId: string | null,
): Promise<void> {
  try {
    const phones = await getActiveAdminPhones(db).catch(() => [] as string[]);
    if (!phones.length) return;
    const timeIst = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const text =
      `🔧 *App problem — needs a human*\n\n` +
      `*Student:* ${diagnosis.context.name ?? "unknown"} (+${phone})\n` +
      `*Batch:* ${diagnosis.context.batch ?? "—"} | *Payment:* ${diagnosis.context.paymentStatus ?? "—"}\n` +
      `*Diagnosis:* ${diagnosis.title}\n` +
      `${diagnosis.detail}\n` +
      (diagnosis.context.clientError ? `*Phone error:* ${diagnosis.context.clientError}\n` : ``) +
      (diagnosis.context.serverBreakage ? `*Server breakage:* ${diagnosis.context.serverBreakage}\n` : ``) +
      `*Ticket:* ${ticketId ?? "could not be filed — check Support Inbox"}\n` +
      `*Time:* ${timeIst} IST\n\n` +
      `What was already tried: automatic diagnosis from the student's record (no fix applied itself). The student was told it is reported and we are fixing it.`;
    await Promise.all(phones.map((p) => sendWhatsAppText(p, text).catch(() => false)));
  } catch (e) {
    console.error("[app-diagnose] admin escalation failed:", (e as Error).message);
  }
}

async function fileTicketFor(
  db: SupabaseClient,
  phone: string,
  diagnosis: Diagnosis,
  screen: string | null,
): Promise<string | null> {
  const student = await findStudentByPhone(db, phone).catch(() => null);
  return fileDiagnoseTicket(db, {
    studentId: (student as { id?: string } | null)?.id ?? null,
    phone: normalizePhone(phone),
    name: diagnosis.context.name,
    batchId: (student as { batch_id?: string | null } | null)?.batch_id ?? null,
    college: (student as { college?: string | null } | null)?.college ?? null,
    diagnosis,
    screen,
    source: "whatsapp",
  });
}

/**
 * Handle one "app not working" report (or a reply to our one question).
 * Returns the short label the router records as the bot's turn.
 */
export async function handleAppProblem(
  db: SupabaseClient,
  waFrom: string,
  phone: string,
  text: string,
): Promise<string> {
  // A reply to our "which screen?" question: re-diagnose with that screen.
  const pending = await loadPending(db, phone, PENDING_INTENT).catch(() => null);
  let screenHint: string | null = text;
  if (pending) {
    await clearPending(db, phone).catch(() => {});
    screenHint = parseAppScreenReply(text) ?? text;
  }

  const diagnosis = await diagnoseStudent(db, phone, { screen: screenHint });

  // The one question, only when the record explains nothing. Buttons come
  // back as menu selections (app_screen_*), handled in the router.
  if (diagnosis.issue === "unknown" && !pending) {
    await savePending(db, phone, PENDING_INTENT, { asked: "screen" }).catch(() => {});
    await sendWhatsAppButtons(waFrom, "I checked your account — registration, batch and payment all look fine, and your phone reported no crash. So I need one detail to find it:\n\nWhich screen are you stuck on?", [
      { id: "app_screen_login", title: "Login / code" },
      { id: "app_screen_inside", title: "After login" },
      { id: "app_screen_payment", title: "Payment" },
    ]);
    return "app-diagnose:asked-screen";
  }

  const label = `app-diagnose:${diagnosis.issue}`;
  const intro = `${diagnosis.title}\n\n${diagnosis.detail}`;

  switch (diagnosis.fix.kind) {
    case "verify_code": {
      const url = diagnosis.fix.url ?? (await buildVerifyLink().catch(() => null));
      if (url) {
        await sendWhatsAppCtaButton(waFrom, intro, "Get code on WhatsApp", url, "Student Platform");
      } else {
        await sendWhatsAppText(waFrom, `${intro}\n\n${diagnosis.fix.note}`);
      }
      return label;
    }
    case "register": {
      const url = diagnosis.fix.url ?? (await buildRegisterLink().catch(() => null));
      if (url) {
        await sendWhatsAppCtaButton(waFrom, intro, "Register on WhatsApp", url, "Student Platform");
      } else {
        await sendWhatsAppText(waFrom, `${intro}\n\n${diagnosis.fix.note}`);
      }
      return label;
    }
    case "open_app":
    case "resume_registration":
    case "retry_payment": {
      if (diagnosis.fix.url) {
        await sendWhatsAppCtaButton(waFrom, intro, "Open Student App", diagnosis.fix.url, "Student Platform");
      } else {
        await sendWhatsAppText(waFrom, `${intro}\n\n${diagnosis.fix.note}`);
      }
      return label;
    }
    case "reupload_id": {
      await sendWhatsAppText(waFrom, intro);
      await startIdReuploadFlow(db, waFrom, phone);
      return label;
    }
    case "clear_data": {
      await sendWhatsAppText(waFrom, intro);
      // The repair page does the reset for them — one tap, no menu steps
      // to explain. The photo goes too, for the student whose installed
      // app won't open the link: open it in Chrome instead.
      const fixUrl = diagnosis.fix.url;
      if (fixUrl) {
        await sendWhatsAppCtaButton(
          waFrom,
          "If the app still won't open, tap here — the fix page clears the stuck login and opens a fresh sign-in. Open it in Chrome if the installed app stays stuck.",
          "Open the fix page",
          fixUrl,
          "Student Platform",
        );
      }
      await sendFixFor(waFrom, "clear_data");
      return label;
    }
    case "wait_server":
    case "ticket": {
      const ticketId = diagnosis.needsTicket
        ? await fileTicketFor(db, phone, diagnosis, screenHint)
        : null;
      await sendWhatsAppText(
        waFrom,
        `${intro}\n\nReported — we are fixing it. No need to message anyone.`,
      );
      // Escalate only when a human must act for THIS student. The known
      // server breakage (case-status lookup) is covered once by the
      // health-check alert, not once per student.
      if (diagnosis.issue === "unknown" || diagnosis.issue === "batch_closed" || diagnosis.issue === "batch_not_active") {
        await escalateToAdmins(db, phone, diagnosis, ticketId);
      }
      return label;
    }
    default:
      return label;
  }
}
