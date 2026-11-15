import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, notFound, badRequest, serverError } from "@/lib/api-response";
import { createDownloadUrl } from "@/lib/storage";
import { verifyCollegeId } from "@/lib/id-ocr";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * POST /api/admin/students/[id]/college-id-check
 *
 * Runs the same AI signature check the registration upload triggers
 * automatically, on demand for an already-uploaded College ID — the
 * on-upload check only ever ran once at upload time, so a student who
 * registered before it existed (or before the vision provider was working)
 * has no `college_id_ai_flag` on file and no
 * way to get one short of re-uploading. Saves the result the same way the
 * upload route does, so the students roster's "needs attention" dot and
 * the Docs sheet's note pick it up immediately. Never mutates anything else
 * — assists review, doesn't decide.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  try {
    const db = createServiceClient();
    const { data: profile } = await db
      .from("profiles")
      .select("id, college_id_path")
      .eq("id", id)
      .maybeSingle();

    if (!profile) return notFound("Student");
    if (!profile.college_id_path) return badRequest("This student has no College ID uploaded to check.");

    const imageUrl = await createDownloadUrl("docs", profile.college_id_path);
    const result = await verifyCollegeId(imageUrl);

    if (!result) return ok({ available: false });

    const { error: updateErr } = await db
      .from("profiles").update({ college_id_ai_flag: result }).eq("id", id);
    if (updateErr) console.error("[api/admin/students/[id]/college-id-check] flag save failed:", updateErr.message);

    return ok({ available: true, result });
  } catch (err) {
    console.error("[api/admin/students/[id]/college-id-check]", err);
    return serverError();
  }
}
