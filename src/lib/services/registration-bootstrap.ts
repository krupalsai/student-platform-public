import { sessionTtlDays } from "@/lib/session";
import { SupabaseClient } from "@supabase/supabase-js";
import { RegistrationTokenPayload, attachProfileToToken } from "@/lib/registration-token";
import { getAdmin } from "@/lib/whatsapp/admin-service";
import { getBatchStatus } from "@/lib/services/batches";
import { resolveUpiDetails, buildUpiLink } from "@/lib/services/payment-settings";
import { generateToken } from "@/lib/token";

// One TTL rule for every login path (student 30d hard / staff 7d idle) — session.ts.
const TTL = (role: string) => new Date(Date.now() + sessionTtlDays(role) * 86400000).toISOString();

/**
 * The website-registration equivalent of /api/auth/telegram: given an
 * already-validated registration token payload, finds or creates the
 * student's profile by phone (never a duplicate — profiles.phone has a
 * uniqueness constraint on the normalized form) and mints a normal
 * session with telegram_id: null.
 *
 * Extracted out of the old /api/registration-tokens/start route so both
 * that route and the OTP-verification flow (verify-otp) share one
 * implementation. Returns null (with an httpStatus/error) if the batch
 * tied to this token is no longer active.
 */
export async function bootstrapSessionFromToken(db: SupabaseClient, payload: RegistrationTokenPayload) {
  const batch = await getBatchStatus(db, payload.batchId);
  if (!batch || batch.status !== "active") {
    return { ok: false as const, error: "This registration link is no longer valid." };
  }
  const { data: batchPayment } = await db
    .from("batches")
    .select("upi_id, upi_name, upi_link")
    .eq("id", payload.batchId)
    .maybeSingle();

  // Find-or-create by phone — never a duplicate student.
  const { data: existingId } = await db.rpc("find_profile_by_normalized_phone", { p_phone: payload.phone });
  let profileId: string | null = existingId ?? null;

  // Two separate admin systems exist in this codebase: the WhatsApp-side
  // `admins` table (checked here) and each website profile's own `role`
  // column. They were never connected — a recognized WhatsApp admin
  // visiting a registration link got a normal 'student' profile and was
  // shown the registration form instead of being routed to /admin. Check
  // once here and use it for both the create and self-heal paths below.
  const waAdmin = await getAdmin(db, payload.phone);
  const resolvedRole = waAdmin ? "admin" : "student";

  let isProfileComplete = false;
  let role = resolvedRole;
  if (profileId) {
    const { data: existing } = await db.from("profiles").select("is_profile_complete, role").eq("id", profileId).maybeSingle();
    isProfileComplete = existing?.is_profile_complete ?? false;
    role = existing?.role ?? resolvedRole;
    // Self-heal: an existing profile predating this admin's WhatsApp
    // admin status (or one that just never got flagged) shouldn't stay
    // stuck as 'student' forever.
    // Never overwrite an existing 'super_admin' back down to plain 'admin'
    // here — same class of silent-demotion bug fixed in
    // whatsapp/admin-login.ts's generateAdminLoginLink.
    if (waAdmin && !["admin", "super_admin"].includes(role)) {
      await db.from("profiles").update({ role: "admin" }).eq("id", profileId);
      role = "admin";
    }
  } else {
    const { data: created, error: cErr } = await db
      .from("profiles")
      .insert({ phone: payload.phone, role: resolvedRole })
      .select("id")
      .single();
    if (cErr || !created) return { ok: false as const, error: "Could not create profile" };
    profileId = created.id;
  }

  if (!profileId) return { ok: false as const, error: "Could not resolve profile" };

  await attachProfileToToken(db, payload.id, profileId);

  // Single active session per user, same convention as the Telegram
  // flow — but cleaned up by student_id here, since there's no
  // telegram_id to key on yet (and may never be one).
  await db.from("sessions").delete().eq("student_id", profileId);
  const { raw, hashed } = generateToken();
  await db.from("sessions").insert({
    student_id: profileId,
    token_hash: hashed,
    expires_at: TTL(role),
  });

  const upi = await resolveUpiDetails(db, batchPayment);
  const upi_link = batchPayment?.upi_link ||
    (batch.fee_amount != null ? buildUpiLink(upi, batch.fee_amount) : null);

  return {
    ok: true as const,
    data: {
      token: raw,
      profile_id: profileId,
      role,
      is_profile_complete: isProfileComplete,
      phone: payload.phone,
      batch: {
        id: batch.id,
        name: batch.name,
        slug: batch.slug,
        college: payload.college,
        upi_id: upi.upi_id,
        // Must be returned for the same reason as in /api/batches/by-slug:
        // the payment screen otherwise falls back to the batch name for the
        // payee shown on screen and encoded as pn= in the QR.
        upi_name: upi.upi_name,
        fee_amount: batch.fee_amount,
        upi_link,
      },
    },
  };
}
