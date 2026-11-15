import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";
import { getExtraFeeState, reconcileExtraFeeOrders } from "@/lib/services/extra-fee";

/** GET /api/extra-fee — the student's second-payment status (settles any captured-but-unrecorded order first). */
export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return forbidden();
  try {
    const db = createServiceClient();
    await reconcileExtraFeeOrders(db, user.profileId);
    const { batchId: _b, reason: _r, ...state } = await getExtraFeeState(db, user.profileId);
    return ok(state);
  } catch (e) {
    console.error("[api/extra-fee]", e);
    return serverError();
  }
}
