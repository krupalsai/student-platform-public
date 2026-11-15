import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, notFound, serverError, badRequest } from "@/lib/api-response";
import { createDownloadUrl } from "@/lib/storage";

// Generic student-document viewer — currently backs Photo+Signature.
// College ID keeps its own dedicated route (../college-id) for backward
// compatibility with existing callers; this route covers any additional
// document fields added going forward via the ?field= query param.
const FIELD_COLUMNS: Record<string, string> = {
  photo_signature: "photo_signature_path",
  college_id:      "college_id_path",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  const { id } = await params;
  const field = req.nextUrl.searchParams.get("field") ?? "";
  const column = FIELD_COLUMNS[field];
  if (!column) return badRequest("Invalid or missing field");

  try {
    const db = createServiceClient();
    const { data: profile } = await db
      .from("profiles")
      .select(column)
      .eq("id", id)
      .maybeSingle();

    const path = profile ? (profile as any)[column] as string | null : null;
    if (!path) return notFound("Document");

    const url = await createDownloadUrl("docs", path);
    return ok({ url });
  } catch (err) { console.error("[api/admin/students/[id]/document]", err);
    return serverError();
  }
}
