import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Student lookup service.
 *
 * phone-based lookup is a first-class path here, not an afterthought.
 */

const PROFILE_WITH_BATCH =
  "*,batches!profiles_batch_id_fkey(id,name,slug,fee_amount,college,status,upi_id,upi_link,case_type,case_number,case_year,case_status_url,representative_name,representative_phone)";

/**
 * Stored profiles.phone is always a plain 10-digit number (confirmed against
 * production data). Incoming numbers — especially from WhatsApp, which
 * sends +91XXXXXXXXXX / spaced / dashed formats — need normalizing to that
 * same shape before any lookup, or an exact match silently misses. Done
 * here, once, so every caller (WhatsApp today, anything else later) gets
 * correct matching without having to know this.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Full raw profile row (+ nested batch), unchanged shape — this is exactly
 * what GET /api/profile has always returned to the dashboard. Kept as its
 * own function so that route can move to this shared lookup without its
 * response shape changing at all.
 */
export async function getStudentProfileRaw(db: SupabaseClient, studentId: string) {
  const { data } = await db.from("profiles").select(PROFILE_WITH_BATCH).eq("id", studentId).single();
  if (!data || data.is_profile_complete) return data;

  // A freshly verified website registration has authoritative phone/college
  // in its still-active registration token. Surface those values while the
  // profile is incomplete so the Complete Profile form can pre-fill them.
  const { data: registrationToken } = await db
    .from("registration_tokens")
    .select("phone, college")
    .eq("profile_id", studentId)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!registrationToken) return data;

  return {
    ...data,
    phone: data.phone || registrationToken.phone,
    college: data.college || registrationToken.college,
  };
}

export async function findStudentByPhone(db: SupabaseClient, phone: string) {
  const { data } = await db.from("profiles").select(PROFILE_WITH_BATCH)
    .eq("phone", normalizePhone(phone)).eq("role", "student").maybeSingle();
  return data;
}

export async function findStudentByRollNumber(db: SupabaseClient, rollNumber: string) {
  const { data } = await db.from("profiles").select(PROFILE_WITH_BATCH)
    .ilike("roll_number", rollNumber).eq("role", "student").maybeSingle();
  return data;
}
