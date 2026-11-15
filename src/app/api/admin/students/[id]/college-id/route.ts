import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, notFound, serverError } from "@/lib/api-response";
import { createDownloadUrl } from "@/lib/storage";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  try {
    const db = createServiceClient();
    const { data: profile } = await db
      .from("profiles")
      .select("college_id_path")
      .eq("id", id)
      .maybeSingle();

    if (!profile?.college_id_path) return notFound("College ID");

    // createDownloadUrl handles both Cloudinary (new) and Supabase (legacy) paths
    const url = await createDownloadUrl("docs", profile.college_id_path);
    return ok({ url });
  } catch (err) { console.error("[api/admin/students/[id]/college-id]", err);
    return serverError();
  }
}
