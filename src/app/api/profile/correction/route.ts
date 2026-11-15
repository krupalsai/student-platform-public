import { NextRequest } from "next/server";
import { z } from "zod";
import { isDocumentStoragePath } from "@/lib/storage-paths";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { ok, forbidden, serverError, zodError, badRequest, dbError } from "@/lib/api-response";

/**
 * POST /api/profile/correction
 *
 * Correction window — lets a student fix limited fields even after payment
 * is approved. Intentionally narrow: only fields that do not affect batch
 * assignment or roll-number uniqueness.
 *
 * The window closes on whichever happens first:
 *   - the student's batch is closed by an admin (checked below,
 *     unconditionally — applies even before payment approval), or
 *   - CORRECTION_WINDOW_DAYS after payment approval.
 *
 * Locked forever (not changeable here):
 *   roll_number, branch, year, college, batch_id, is_profile_complete
 */

const CorrectionSchema = z.object({
  full_name:       z.string().trim().min(2).max(120).optional(),
  father_name:     z.string().trim().min(2).max(120).optional(),
  phone:           z.string().trim().regex(/^[6-9]\d{9}$/, "Invalid 10-digit mobile number").optional(),
  home_address:    z.string().trim().min(5).max(500).optional(),
  // A storage reference this server issued, not free text — otherwise a
  // student can point their college ID at another student's upload.
  college_id_path: z.string().trim().refine(isDocumentStoragePath, "Invalid document reference").optional(),
}).refine(d => Object.keys(d).length > 0, { message: "No fields to update" });

// Correction window stays open for this many days after payment approval.
// Before approval (submitted / pending) the window is always open.
const CORRECTION_WINDOW_DAYS = 7;

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  const body = CorrectionSchema.safeParse(await req.json());
  if (!body.success) return zodError(body.error);

  const db = createServiceClient();

  // Must have completed initial registration
  const { data: profile } = await db
    .from("profiles")
    .select("id, phone, is_profile_complete, batches!profiles_batch_id_fkey(status)")
    .eq("id", user!.profileId)
    .single();

  if (!profile?.is_profile_complete) {
    return badRequest("Complete your profile first via the normal registration flow.");
  }

  // Closing the batch closes the correction window too, regardless of the
  // 7-day-after-approval timer below — once the admin has closed the batch
  // the cohort is finalised, so there's nothing left for a student's own
  // correction to change. Checked first because it's the broader condition:
  // it applies even to a student who hasn't paid yet, whose window would
  // otherwise stay open indefinitely per the "always open before approval"
  // rule just below.
  const batchStatus = (profile.batches as any)?.status;
  if (batchStatus === "closed") {
    return badRequest("Your batch has been closed, so the correction window is closed too. Contact your admin for further changes.");
  }

  // Enforce window only after payment is approved
  const { data: payment } = await db
    .from("payments")
    .select("status, approved_at")
    .eq("student_id", user!.profileId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (payment?.status === "approved" && payment?.approved_at) {
    const approvedAt  = new Date(payment.approved_at).getTime();
    const windowClose = approvedAt + CORRECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() > windowClose) {
      return badRequest(
        `The correction window closed ${CORRECTION_WINDOW_DAYS} days after your payment was approved. Contact your admin for further changes.`
      );
    }
  }

  // The phone number IS the login identity. Changing it with only a session
  // would let a stolen session take the account over permanently, so a changed
  // number is refused here until a fresh-OTP flow exists (admin can edit it).
  const { phone: newPhone, ...rest } = body.data;
  if (newPhone && newPhone !== (profile as { phone?: string | null }).phone) {
    return badRequest("Changing your phone number needs fresh verification. Please contact your admin to update it.");
  }
  if (Object.keys(rest).length === 0) return ok(profile);

  const { data, error: err } = await db
    .from("profiles")
    .update(rest)
    .eq("id", user!.profileId)
    .select()
    .single();

  if (err) return dbError("api/profile/correction", err);

  await audit(
    "profile.correction",
    "profile",
    user!.profileId,
    { fields: Object.keys(rest) },
    user!.profileId,
    "student",
  );

  return ok(data);
}
