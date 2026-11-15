import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireViewerOrAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";

// POST /api/admin/presence
//
// The GET handler that listed every admin and their last_active_at was
// removed with the presence bar it fed (its only caller). This POST stays:
// Activity Logs reads last_active_at for "Online now" / "Last seen".
// Called every ~25s from AdminHeartbeat while an admin tab is open.
export async function POST(req: NextRequest) {
  const { user, error } = await requireViewerOrAdmin(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();
    await db
      .from("profiles")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", user!.profileId);
    return ok({ ok: true });
  } catch (err) { console.error("[api/admin/presence]", err);
    return serverError();
  }
}
