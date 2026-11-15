import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSystemError } from "@/lib/system-errors";
import { ok, badRequest, tooManyRequests } from "@/lib/api-response";
import { diagnoseStudent, fileDiagnoseTicket } from "@/lib/diagnose";
import { normalizePhone } from "@/lib/services/students";

export const dynamic = "force-dynamic";

/**
 * POST /api/diagnose — the in-app "App not working?" check.
 *
 * Public on purpose (a stuck student may have no valid session), so it is
 * strictly bounded: per-IP + per-phone rate limits, every field
 * length-capped, and the answer only ever describes the caller's own
 * record, in coarse plain language — no amounts, no transaction refs, no
 * other student's data. The login page already discloses the same
 * coarse "this number is not registered" state, so this reveals nothing
 * new; it just answers it with a fix instead of a dead end.
 *
 * Body: { phone, screen?, error?, device? }
 * Returns: { diagnosis: { issue, title, detail, fix }, ticketFiled, ticketId }
 * When the diagnosis needs a human, a support thread is filed
 * automatically (student_queries, category technical) and the student is
 * told it is reported — they do not need to find anyone.
 */
const Schema = z.object({
  phone: z.string().max(20),
  screen: z.string().max(200).optional(),
  error: z.string().max(400).optional(),
  device: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const body = Schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest("Enter your registered mobile number.");
  const phone = normalizePhone(body.data.phone);
  if (phone.length !== 10) return badRequest("Enter a valid 10-digit mobile number.");

  const db = createServiceClient();
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  const ipLimit = await checkRateLimit(db, `diagnose:${ip}`, 20, 900);
  if (!ipLimit.allowed) return tooManyRequests("Too many checks. Try again in a few minutes.");
  const phoneLimit = await checkRateLimit(db, `diagnose-phone:${phone}`, 5, 3600);
  if (!phoneLimit.allowed) return tooManyRequests("Too many checks for this number. Try again later.");

  const diagnosis = await diagnoseStudent(db, phone, {
    screen: body.data.screen ?? null,
    error: body.data.error ?? null,
  });

  let ticketId: string | null = null;
  if (diagnosis.needsTicket) {
    // The student's own profile id / batch / college for the thread.
    // Looked up again here so the endpoint — not the shared engine —
    // owns the ticket write.
    const { findStudentByPhone } = await import("@/lib/services/students");
    const student = await findStudentByPhone(db, phone).catch(() => null);
    ticketId = await fileDiagnoseTicket(db, {
      studentId: (student as { id?: string } | null)?.id ?? null,
      phone,
      name: diagnosis.context.name,
      batchId: (student as { batch_id?: string | null } | null)?.batch_id ?? null,
      college: (student as { college?: string | null } | null)?.college ?? null,
      diagnosis,
      screen: body.data.screen ?? null,
      error: body.data.error ?? null,
      source: "student_app",
    });
    if (diagnosis.issue === "unknown") {
      await logSystemError(db, "support/diagnose-unknown", new Error(`diagnose unknown for +${phone}`), {
        screen: body.data.screen ?? null,
        device: body.data.device ?? null,
      }).catch(() => {});
    }
  }

  return ok({
    diagnosis: {
      issue: diagnosis.issue,
      title: diagnosis.title,
      detail: diagnosis.detail,
      fix: diagnosis.fix,
    },
    ticketFiled: diagnosis.needsTicket,
    ticketId,
  });
}
