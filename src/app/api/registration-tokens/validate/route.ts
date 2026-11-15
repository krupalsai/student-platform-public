import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { validateRegistrationToken } from "@/lib/registration-token";
import { getBatchStatus } from "@/lib/services/batches";
import { ok, zodError, serverError } from "@/lib/api-response";

const Schema = z.object({ token: z.string().min(1) });

/**
 * POST /api/registration-tokens/validate
 *
 * Used by the website registration page on load. Deliberately returns the
 * same generic "invalid or expired" response whether the token doesn't
 * exist, expired, or was already consumed by a completed payment — so a
 * client probing tokens can't learn which case it hit.
 */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const db = createServiceClient();
    const payload = await validateRegistrationToken(db, body.data.token);
    if (!payload) {
      return NextResponse.json({ success: false, error: "This registration link is no longer valid." }, { status: 410 });
    }

    const batch = await getBatchStatus(db, payload.batchId);
    if (!batch || batch.status !== "active") {
      return NextResponse.json({ success: false, error: "This registration link is no longer valid." }, { status: 410 });
    }

    /**
     * `is_profile_complete` tells the caller whether this link's OWNER has
     * already finished registering. Without it, an app launch carrying a
     * stale hand-off token had no way to know the registration form is
     * pointless, so it showed it anyway — which is what sent registered
     * students back to the form on every open.
     *
     * It leaks nothing new: this endpoint already returns the phone and
     * profile_id for a token the caller is holding.
     */
    let profileComplete = false;
    if (payload.profileId) {
      const { data: prof } = await db
        .from("profiles")
        .select("is_profile_complete")
        .eq("id", payload.profileId)
        .maybeSingle();
      profileComplete = Boolean(prof?.is_profile_complete);
    }

    return ok({
      phone: payload.phone,
      college: payload.college,
      batch: { id: batch.id, name: batch.name, slug: batch.slug, fee_amount: batch.fee_amount },
      profile_id: payload.profileId,
      is_profile_complete: profileComplete,
    });
  } catch (e) {
    console.error("[api/registration-tokens/validate]", e);
    return serverError();
  }
}
