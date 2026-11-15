import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { issueRegistrationToken } from "@/lib/registration-token";
import { joinWaitlist, getWaitlistCount } from "@/lib/services/waitlist";
import { notifyAdminOfWaitlistJoin } from "@/lib/whatsapp/admin";
import { getCollegeName } from "@/lib/services/colleges";
import { normalizePhone } from "@/lib/services/students";
import { ok, zodError, serverError, badRequest } from "@/lib/api-response";

const Schema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(10).max(13),
  college: z.string().trim().min(1).max(200),
});

/**
 * POST /api/signup/start
 *
 * Web sign-up for a LISTED college. No session needed — this is the entry
 * point for a brand-new student.
 *
 *  - Validates the college against the real `colleges` table (active only).
 *  - Issues a registration token for the phone + college's active batch and
 *    returns the /register URL, so the existing registration flow
 *    (phone+OTP verify → profile → payment) takes over. The token alone
 *    grants nothing — /register still requires the 6-digit phone OTP.
 *  - If there is no active batch for that college, the student joins the
 *    waiting list instead (same joinWaitlist + admin notify as the
 *    WhatsApp path) and gets their queue position back.
 *
 * Rate-limiting note: issueRegistrationToken reuses an existing still-valid
 * token for the same phone + college + batch, so repeated taps do not mint
 * new rows. The token is useless without the phone OTP, so this endpoint
 * cannot be used to sign in as someone else.
 */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const { name, college } = body.data;
    const phone = normalizePhone(body.data.phone);
    if (!/^\d{10}$/.test(phone)) return badRequest("Please enter a valid 10-digit mobile number.");

    const db = createServiceClient();

    // The college must be a real, active, listed college.
    const { data: collegeRow } = await db
      .from("colleges")
      .select("id, name")
      .eq("id", college)
      .eq("active", true)
      .maybeSingle();
    if (!collegeRow) return badRequest("Please pick your college from the list, or choose 'My college isn't listed'.");

    // Try to start registration for this college's active batch.
    const issued = await issueRegistrationToken(db, phone, collegeRow.id);
    if (issued) {
      const url = issued.shortCode ? `/register?token=${issued.shortCode}` : `/register?token=${issued.raw}`;
      return ok({ action: "register", url, college: collegeRow.name });
    }

    // No active batch — waiting list, same as the WhatsApp path.
    const { alreadyWaiting, position } = await joinWaitlist(db, collegeRow.id, phone);
    if (!alreadyWaiting) {
      const collegeName = await getCollegeName(db, collegeRow.id);
      const waitingCount = await getWaitlistCount(db, collegeRow.id);
      await notifyAdminOfWaitlistJoin(db, collegeName, waitingCount, waitingCount === 1).catch(() => {});
    }
    return ok({ action: "waitlisted", position, college: collegeRow.name });
  } catch (e) {
    console.error("[api/signup/start]", e);
    return serverError();
  }
}
