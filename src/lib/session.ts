import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { hashToken } from "@/lib/token";
export interface SessionUser { profileId: string; role: string; isProfileComplete: boolean; batchId: string | null; }
const STAFF_ROLES = ["admin", "super_admin", "viewer"];
const DAY_MS = 86400000;

/** Students: HARD 30-day expiry from login; staff only 7 (higher privilege). */
export function sessionTtlDays(role: string): number {
  if (STAFF_ROLES.includes(role)) return Math.max(1, parseInt(process.env.ADMIN_SESSION_TTL_DAYS ?? "7", 10) || 7);
  // Locked rule (2026-10-26, Krupal: back to the old time): a student session
  // ends 30 days after LOGIN, no matter how often the app is opened — it is
  // NOT sliding. The long sliding session is what kept stale builds crashing.
  // Deliberately NOT the legacy SESSION_TTL_DAYS — production still carries
  // that variable (30) from the old design, but it is not read here.
  return Math.max(1, parseInt(process.env.STUDENT_SESSION_TTL_DAYS ?? "30", 10) || 30);
}

export function readSessionToken(req: NextRequest): { raw: string; fromCookie: boolean } {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const headerToken = (req.headers.get("x-session-token") ?? "").trim();
  if (bearer || headerToken) return { raw: bearer || headerToken, fromCookie: false };
  return { raw: req.cookies.get("sp_session")?.value?.trim() ?? "", fromCookie: true };
}

/** Sets/refreshes the HttpOnly session cookie, aged to match the role's limit. */
export function setSessionCookie(res: { cookies: { set: (name: string, value: string, opts: object) => unknown } }, raw: string, role: string) {
  res.cookies.set("sp_session", raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: sessionTtlDays(role) * 86400,
  });
}

/** A cookie-only mutating request must come from our own origin (CSRF guard). */
function sameOriginOk(req: NextRequest): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const origin = req.headers.get("origin");
  if (origin) {
    try { return new URL(origin).host === req.headers.get("host"); } catch { return false; }
  }
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

export async function getSession(req: NextRequest): Promise<SessionUser | null> {
  const { raw, fromCookie } = readSessionToken(req);
  if (!raw) return null;
  if (fromCookie && !sameOriginOk(req)) return null;
  const db = createServiceClient();
  const { data: s } = await db.from("sessions")
    .select("student_id, expires_at, created_at, last_used_at, profiles(id,role,is_profile_complete,batch_id)")
    .eq("token_hash", hashToken(raw)).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!s) return null;
  const p = s.profiles as unknown as { id:string; role:string; is_profile_complete:boolean; batch_id:string|null } | null;
  if (!p) return null;
  const ttlMs = sessionTtlDays(p.role) * DAY_MS;
  const isStaff = STAFF_ROLES.includes(p.role);
  // Idle limit by CURRENT role, so a session minted with the student limit
  // cannot outlive the 7-day staff limit after a promotion.
  const lastUsed = new Date(s.last_used_at ?? s.created_at ?? s.expires_at).getTime();
  if (isStaff && Date.now() - lastUsed > ttlMs) return null;
  const patch: { last_used_at: string; expires_at?: string } = { last_used_at: new Date().toISOString() };
  if (isStaff) {
    // Staff keep the sliding window: every use pushes expiry out.
    if (new Date(s.expires_at).getTime() - Date.now() < ttlMs * 0.9) patch.expires_at = new Date(Date.now() + ttlMs).toISOString();
  } else {
    // Students: HARD 30-day expiry from login (created_at) — opening the app
    // does NOT extend it. Sessions minted under the old 90-day rule shrink to
    // the new limit on their next refresh; one already past 30 days ends now.
    const createdAtMs = s.created_at ? new Date(s.created_at).getTime() : NaN;
    if (!Number.isNaN(createdAtMs)) {
      const hardExpiry = createdAtMs + ttlMs;
      if (Date.now() > hardExpiry) return null;
      if (new Date(s.expires_at).getTime() > hardExpiry) patch.expires_at = new Date(hardExpiry).toISOString();
    }
  }
  db.from("sessions").update(patch).eq("token_hash", hashToken(raw)).then(()=>null);
  return { profileId: p.id, role: p.role, isProfileComplete: p.is_profile_complete, batchId: p.batch_id ?? null };
}
export async function requireSession(req: NextRequest) {
  const user = await getSession(req);
  return user ? { user, error: null } : { user: null, error: "UNAUTHORIZED" as const };
}
/** Admin console access: both normal admins and super admins. */
export async function requireAdmin(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return { user: null, error };
  if (!["admin", "super_admin"].includes(user!.role)) return { user: null, error: "FORBIDDEN" as const };
  return { user: user!, error: null };
}
export async function requireViewerOrAdmin(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return { user: null, error };
  if (!["viewer","admin","super_admin"].includes(user!.role)) return { user: null, error: "FORBIDDEN" as const };
  return { user: user!, error: null };
}
/** Sensitive operations remain Super Admin only. */
export async function requireSuperAdmin(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return { user: null, error };
  if (user!.role !== "super_admin") return { user: null, error: "FORBIDDEN" as const };
  return { user: user!, error: null };
}
/** Health and Activity Logs: viewer read-only access is retained. */
export async function requireViewerOrSuperAdmin(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return { user: null, error };
  if (!["viewer","super_admin"].includes(user!.role)) return { user: null, error: "FORBIDDEN" as const };
  return { user: user!, error: null };
}
