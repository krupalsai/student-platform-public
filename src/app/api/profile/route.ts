import { audit } from "@/lib/audit";
import { logStudentEvent } from "@/lib/student-events";
import { checkAndNotifyLowSeats } from "@/lib/low-seat-alerts";
import { checkAndNotifyBatchMilestone } from "@/lib/batch-seat-milestone";
import { getStudentProfileRaw } from "@/lib/services/students";
import { createPetitionForStudent } from "@/lib/services/petitions";
import { notifyStudent, registrationCompleteMessage } from "@/lib/services/student-notifications";
import { PETITION_MIN_SEATS } from "@/lib/config";
import { NextRequest } from "next/server";
import { z } from "zod";
import { isDocumentStoragePath } from "@/lib/storage-paths";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError, zodError, fieldError, conflict, dbError } from "@/lib/api-response";

const UpdateSchema = z.object({
  full_name:       z.string().trim().min(2).max(120),
  father_name:     z.string().trim().min(2).max(120),
  gender:          z.enum(["male", "female"]),
  phone:           z.string().trim().regex(/^[6-9]\d{9}$/, "Invalid 10-digit mobile number"),
  college:         z.string().trim().min(1).max(50),
  roll_number:     z.string().trim().min(2).max(50),
  branch:          z.string().trim().min(1).max(80),
  year:            z.string().trim().min(1),
  // A storage reference /api/uploads/college-id issued, not free text.
  college_id_path: z.string().trim().refine(isDocumentStoragePath, "Invalid document reference"),
  home_address:    z.string().trim().min(5).max(500),
  batch_slug:      z.string().trim().min(1).optional(),
});

export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const db = createServiceClient();
  const data = await getStudentProfileRaw(db, user!.profileId);
  return ok(data);
}

export async function PATCH(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  try {
    const body = UpdateSchema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const db = createServiceClient();
    const { data: collegeRow } = await db
      .from("colleges")
      .select("id")
      .eq("id", body.data.college)
      .eq("active", true)
      .maybeSingle();
    if (!collegeRow) return fieldError("college", "Invalid college");

    const { data: dup } = await db.from("profiles")
      .select("id")
      .eq("roll_number", body.data.roll_number)
      .eq("college", body.data.college)
      .neq("id", user!.profileId)
      .maybeSingle();
    if (dup) return conflict("Roll number already registered for this college");

    const { data: before } = await db.from("profiles")
      .select("is_profile_complete, batch_id, full_name")
      .eq("id", user!.profileId)
      .single();
    const wasAlreadyComplete = before?.is_profile_complete === true;

    let batch_id: string | undefined;
    let batchName: string | undefined;
    let batchSlug: string | undefined;
    if (body.data.batch_slug && !before?.batch_id) {
      const { data: batch } = await db.from("batches")
        .select("id, name, slug")
        .eq("slug", body.data.batch_slug)
        .eq("status", "active")
        .maybeSingle();
      if (batch) { batch_id = batch.id; batchName = batch.name; batchSlug = batch.slug; }
    }

    const { batch_slug: _removed, ...profileFields } = body.data;
    const updatePayload: Record<string, unknown> = {
      ...profileFields,
      is_profile_complete: true,
    };
    if (batch_id) updatePayload.batch_id = batch_id;

    const { data, error: err } = await db.from("profiles")
      .update(updatePayload)
      .eq("id", user!.profileId)
      .select()
      .single();

    if (err) return dbError("api/profile", err);

    if (!wasAlreadyComplete) {
      await audit("profile.completed", "profile", data.id, {}, user!.profileId, "student");
      await logStudentEvent(db, {
        student_id: user!.profileId,
        batch_id:    data.batch_id   ?? batch_id ?? null,
        college:     data.college    ?? null,
        event_type:  "registration.completed",
        page:        "/register",
        metadata:    { roll_number: data.roll_number, branch: data.branch },
      });

      const effBatchId = data.batch_id ?? batch_id ?? null;
      let seats: { registered: number; minSeats: number } | undefined;
      if (effBatchId) {
        const { count } = await db
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("batch_id", effBatchId)
          .eq("is_profile_complete", true);
        seats = { registered: count ?? 0, minSeats: PETITION_MIN_SEATS };
      }

      // One WhatsApp notification only. It contains the direct Chrome/PWA URL;
      // no Telegram link or second install message is sent.
      await notifyStudent(
        db, user!.profileId, "registration",
        registrationCompleteMessage(data.full_name ?? "Student", batchName, seats),
      ).catch((e) => console.error("[api/profile] registration notification failed:", e));

      if (effBatchId) {
        await checkAndNotifyBatchMilestone(db, effBatchId).catch((e) => console.error("[api/profile] background task failed:", e));
      }
    }

    if (batch_id) {
      await checkAndNotifyLowSeats(db, batch_id).catch((e) => console.error("[api/profile] background task failed:", e));
      await createPetitionForStudent(db, user!.profileId, batch_id).catch((e) => console.error("[api/profile] background task failed:", e));
    }

    return ok(data);
  } catch (err) {
    console.error("[profile PATCH] unhandled error:", (err as Error)?.message, (err as Error)?.stack);
    return serverError("Registration failed. Please try again.");
  }
}