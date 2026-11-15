/**
 * AdminService
 *
 * Database-backed WhatsApp admin role system.
 * WHATSAPP_ADMIN_NUMBER is the configured bootstrap SUPER_ADMIN.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type AdminRole = "SUPER_ADMIN" | "ADMIN" | "VIEWER";

export interface WaAdmin {
  id: string;
  phone: string;
  role: AdminRole;
  active: boolean;
  created_by: string | null;
  created_at: string;
}

/** Normalize any phone format to its 10-digit local form. */
export function normaliseAdminPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

let bootstrapped = false;

/**
 * Ensure the configured WhatsApp admin exists and is active.
 *
 * The old implementation only bootstrapped when the entire admins table was
 * empty. If another admin row already existed, WHATSAPP_ADMIN_NUMBER could
 * be missing forever, causing LOGIN to fall through to student handling.
 */
export async function bootstrapAdmins(db: SupabaseClient): Promise<void> {
  if (bootstrapped) return;

  const envPhone = normaliseAdminPhone(process.env.WHATSAPP_ADMIN_NUMBER ?? "");
  if (!envPhone) {
    console.warn("[AdminService] WHATSAPP_ADMIN_NUMBER is not set — no admin bootstrap performed.");
    bootstrapped = true;
    return;
  }

  try {
    const { data: existing, error: lookupError } = await db
      .from("admins")
      .select("id, phone, role, active")
      .eq("phone", envPhone)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (!existing) {
      const { error: insertError } = await db.from("admins").insert({
        phone: envPhone,
        role: "SUPER_ADMIN",
        active: true,
        created_by: null,
      });
      if (insertError && insertError.code !== "23505") throw insertError;
      console.log(`[AdminService] bootstrapped SUPER_ADMIN: ${envPhone}`);
    } else if (!existing.active || existing.role !== "SUPER_ADMIN") {
      const { error: repairError } = await db.from("admins").update({
        role: "SUPER_ADMIN",
        active: true,
      }).eq("id", existing.id);
      if (repairError) throw repairError;
      console.log(`[AdminService] repaired configured SUPER_ADMIN: ${envPhone}`);
    }
  } catch (err) {
    console.error("[AdminService] bootstrap error:", (err as Error).message);
  }

  bootstrapped = true;
}

interface CacheEntry { admin: WaAdmin | null; expiresAt: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getAdmin(
  db: SupabaseClient,
  rawPhone: string,
): Promise<WaAdmin | null> {
  const phone = normaliseAdminPhone(rawPhone);
  if (!phone) return null;

  const now = Date.now();
  const cached = cache.get(phone);
  if (cached && cached.expiresAt > now) return cached.admin;

  try {
    const { data, error } = await db
      .from("admins")
      .select("id, phone, role, active, created_by, created_at")
      .eq("phone", phone)
      .eq("active", true)
      .maybeSingle();

    if (error) throw error;
    let admin = data as WaAdmin | null;

    if (!admin) {
      // Dual-role fallback (12 Nov 2026): a student can also be an admin.
      // The `admins` table is the primary source, but a profile whose role
      // is admin/super_admin is authoritative too — that role is set by a
      // real admin in the web app, so trusting it does NOT promote a plain
      // student. Without this, a student-admin whose number was never added
      // to `admins` is treated as a normal student on WhatsApp and cannot
      // reach any admin function.
      const { data: profile, error: profileError } = await db
        .from("profiles")
        .select("id, role")
        .eq("phone", phone)
        .maybeSingle();
      if (profileError) throw profileError;
      if (profile && (profile.role === "admin" || profile.role === "super_admin")) {
        admin = {
          id: profile.id,
          phone,
          role: profile.role === "super_admin" ? "SUPER_ADMIN" : "ADMIN",
          active: true,
          created_by: null,
          created_at: new Date().toISOString(),
        };
      }
    }

    // Misses are cached too, same TTL as hits. Every real promotion/demotion
    // path (upsertAdmin, deactivateAdmin) already calls invalidateAdminCache
    // itself, and bootstrapAdmins only ever touches the one env-configured
    // SUPER_ADMIN row (already repaired before this runs, same request) — so
    // nothing else in this codebase writes to `admins` without going through
    // one of those two functions. Almost every WhatsApp message is from a
    // non-admin student, and without caching the miss, every single one of
    // those re-queried this table for nothing.
    cache.set(phone, { admin, expiresAt: now + CACHE_TTL_MS });

    return admin;
  } catch (err) {
    console.error("[AdminService] getAdmin failed:", (err as Error).message);
    return null;
  }
}

export function invalidateAdminCache(rawPhone: string): void {
  cache.delete(normaliseAdminPhone(rawPhone));
}

export const WA_ROLE_FOR_WEBSITE_ROLE: Record<"admin" | "viewer" | "super_admin", AdminRole> = {
  admin: "ADMIN",
  viewer: "VIEWER",
  super_admin: "SUPER_ADMIN",
};

export async function upsertAdmin(
  db: SupabaseClient,
  rawPhone: string,
  role: AdminRole,
  createdBy: string,
): Promise<void> {
  const phone = normaliseAdminPhone(rawPhone);
  if (!phone) return;
  const { error } = await db.from("admins")
    .upsert({ phone, role, active: true, created_by: createdBy }, { onConflict: "phone" });
  if (error) console.error("[AdminService] upsertAdmin failed:", error.message);
  invalidateAdminCache(phone);
}

export async function deactivateAdmin(db: SupabaseClient, rawPhone: string): Promise<void> {
  const phone = normaliseAdminPhone(rawPhone);
  if (!phone) return;
  const { error } = await db.from("admins").update({ active: false }).eq("phone", phone);
  if (error) console.error("[AdminService] deactivateAdmin failed:", error.message);
  invalidateAdminCache(phone);
}
