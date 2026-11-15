import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { getCurrentActiveBatch } from "@/lib/services/batches";
import { ok, forbidden, serverError } from "@/lib/api-response";

/**
 * GET /api/batches/for-session
 *
 * Resolves the correct active batch for the current session, used by the
 * registration page when no batch slug is available (e.g. student reopens
 * the page after a fresh registration token bootstrap).
 *
 * Resolution order:
 * 1. profile.batch_id — already assigned (returning student)
 * 2. profile.college → getCurrentActiveBatch() — profile has college from
 *    the token bootstrap but batch_id not yet set (first-time student who
 *    partially completed registration)
 * 3. pending registration_token for this profile — college known from token
 *    even before profile.college was set (very first page load)
 *
 * Never returns a waitlist message — that is the caller's job if this
 * returns null.
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return forbidden();

  try {
    const db = createServiceClient();

    // Step 1: get profile
    const { data: profile } = await db
      .from("profiles")
      .select("id, college, batch_id, batches!profiles_batch_id_fkey(id, name, slug, college, status, fee_amount, upi_id, upi_name, upi_link, batch_limit)")
      .eq("id", user.profileId)
      .maybeSingle();

    // Already has a batch assigned
    if (profile?.batch_id && (profile as any).batches) {
      const b = (profile as any).batches;
      return ok({ batch: b, source: "profile_batch_id" });
    }

    // Has a college — find the active batch for it
    if (profile?.college) {
      const batch = await getCurrentActiveBatch(db, profile.college);
      if (batch) return ok({ batch, source: "profile_college" });
    }

    // No college on profile yet — check pending registration token
    const { data: regToken } = await db
      .from("registration_tokens")
      .select("college, batch_id, batches!profiles_batch_id_fkey(id, name, slug, college, status, fee_amount, upi_id, upi_name, upi_link, batch_limit)")
      .eq("profile_id", user.profileId)
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (regToken?.batches) {
      return ok({ batch: regToken.batches, source: "registration_token" });
    }

    if (regToken?.college) {
      const batch = await getCurrentActiveBatch(db, regToken.college);
      if (batch) return ok({ batch, source: "registration_token_college" });
    }

    return ok({ batch: null, source: "none" });
  } catch (e) {
    console.error("[api/batches/for-session]", e);
    return serverError();
  }
}
