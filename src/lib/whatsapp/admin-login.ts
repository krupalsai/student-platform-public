/**
 * WhatsApp "LOGIN" admin command.
 *
 * Generates a one-time admin login link only for an authorized active
 * WhatsApp admin. A student number must never be promoted to admin merely
 * because it sends LOGIN.
 */

import { sessionTtlDays } from "@/lib/session";
import { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, createHash } from "crypto";
import { normalizePhone } from "@/lib/services/students";
import { generateToken } from "@/lib/token";
import { getAdmin, bootstrapAdmins, normaliseAdminPhone } from "@/lib/whatsapp/admin-service";

const OTP_TTL_MS = 10 * 60 * 1000;

// IMPORTANT: WhatsApp LOGIN links must use the canonical production hostname.
// Never derive this from a Vercel preview deployment.
const APP_URL = "https://studentplatform.dev";

function generateRawOtp() {
  const raw = randomBytes(32).toString("hex");
  return { raw, hashed: createHash("sha256").update(raw).digest("hex") };
}

export async function generateAdminLoginLink(db: SupabaseClient, waPhone: string): Promise<string> {
  const phone = normalizePhone(waPhone);

  // Security boundary: only numbers explicitly present in the active admins
  // table may obtain an admin login OTP. Never promote a student profile here.
  await bootstrapAdmins(db);
  const admin = await getAdmin(db, phone);
  if (!admin) throw new Error("Unauthorized admin LOGIN request");

  let { data: profile } = await db.from("profiles")
    .select("id, role")
    .eq("phone", phone)
    .maybeSingle();

  if (!profile) {
    const { data: created, error } = await db.from("profiles")
      .insert({ phone, role: "admin", is_profile_complete: true, full_name: "Admin" })
      .select("id, role")
      .single();
    if (error || !created) throw new Error("Could not create admin profile for login");
    profile = created;
  } else if (!["admin", "super_admin"].includes(profile.role)) {
    // Only promote a non-admin profile to plain 'admin' here — never
    // overwrite an existing 'super_admin' back down to 'admin' just
    // because they requested a WhatsApp LOGIN link. This silently
    // demoted every super_admin on every login before this check excluded
    // them.
    const { data: updated, error } = await db.from("profiles")
      .update({ role: "admin" })
      .eq("id", profile.id)
      .select("id, role")
      .single();
    if (error || !updated) throw new Error("Could not promote authorized admin profile");
    profile = updated;
  }

  const { raw, hashed } = generateRawOtp();
  const { error } = await db.from("admin_login_otps").insert({
    profile_id: profile.id,
    otp_hash: hashed,
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
  });
  if (error) throw error;

  return `${APP_URL}/admin/login?otp=${raw}`;
}

export async function consumeAdminLoginOtp(
  db: SupabaseClient,
  rawOtp: string
): Promise<{ token: string; profileId: string; role: string } | null> {
  const otpHash = createHash("sha256").update(rawOtp).digest("hex");

  const { data: row } = await db.from("admin_login_otps")
    .select("id, profile_id, expires_at, used_at")
    .eq("otp_hash", otpHash)
    .maybeSingle();

  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;

  // Consume atomically and use the returned row as proof that this request won
  // the single-use race. Supabase does not populate `count` unless a count
  // option is explicitly requested, so checking `count` here rejected valid OTPs.
  const { data: consumed, error: consumeError } = await db.from("admin_login_otps")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("used_at", null)
    .select("id")
    .maybeSingle();

  if (consumeError || !consumed) return null;

  const { data: profile } = await db.from("profiles")
    .select("id, role")
    .eq("id", row.profile_id)
    .maybeSingle();
  if (!profile || !["admin", "super_admin"].includes(profile.role)) return null;

  // Defense in depth: the profile must still correspond to an active admin
  // number at the moment the OTP is consumed.
  const { data: profilePhone } = await db.from("profiles")
    .select("phone")
    .eq("id", profile.id)
    .maybeSingle();
  if (!profilePhone?.phone || !(await getAdmin(db, normaliseAdminPhone(profilePhone.phone)))) return null;

  const { raw, hashed } = generateToken();
  const { error: sessionError } = await db.from("sessions").insert({
    student_id: profile.id,
    token_hash: hashed,
    expires_at: new Date(Date.now() + sessionTtlDays(profile.role) * 86400000).toISOString(),
  });
  if (sessionError) return null;

  return { token: raw, profileId: profile.id, role: profile.role };
}
