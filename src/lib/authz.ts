/**
 * Authorisation decisions, stated once and in one place.
 *
 * Pure functions on facts the SERVER has established — a role from the
 * session row, a payment row the server read itself. Nothing here may take an
 * argument that came from the browser.
 *
 * Every role check in this codebase used to be written as a deny-list
 * ("reject if role is student"), which silently grants access to any role
 * added later. They are allow-lists here — an unrecognised role is denied.
 */

export type Role = string;

const STAFF = ["admin", "viewer", "super_admin"];

/** Admin, viewer, or super_admin — the people who run the platform, not the ones using it. */
export function isStaff(role: Role): boolean {
  return STAFF.includes(role);
}

/**
 * May this session read Route Map material — the court/petition documents an
 * admin uploads for a college?
 *
 * Students: only once their payment has been verified by an admin. Before
 * this existed, the API answered any logged-in session, so a registered-but-
 * unpaid student could read every court/petition document uploaded for their
 * college by calling it directly.
 *
 * Staff free pass is super_admin ONLY. Route Map management is hidden from a
 * plain 'admin' again (explicit request: "normal admin shouldn't see activity
 * log and routemap settings and health"), and hiding the nav tile alone would
 * be pointless if that admin could still read the documents by calling
 * /api/route-map/attachments directly. Defence in depth, same as item #63.
 *
 * Unchanged for students: anyone with a verified payment still reads it —
 * that is the student-facing feature, not a staff capability.
 */
export function canReadRouteMap(role: Role, hasVerifiedPayment: boolean): boolean {
  return role === "super_admin" || hasVerifiedPayment === true;
}

/**
 * May this session read a payment record belonging to `ownerId`?
 *
 * Used by the gateway status polls, which are handed a transaction id from
 * the URL and must not become a way to read strangers' payments by guessing.
 */
export function canReadPayment(role: Role, viewerId: string, ownerId: string | null): boolean {
  return isStaff(role) || (!!ownerId && ownerId === viewerId);
}

/**
 * May this session read a batch's group discussion?
 *
 * A student passes only for their OWN batch.
 *
 * Payment approval is deliberately NOT required (changed 2026-09-02, was
 * originally gated on hasApprovedPayment() the same way the old Telegram
 * group invite was) — a registered student should be able to ask questions
 * and talk to their batch before they've paid, not only after. Still
 * requires a completed registration with a batch assigned — see the
 * caller for what "own batch" actually checks.
 */
export function canReadGroupChat(role: Role, isOwnBatch: boolean): boolean {
  // Staff free pass is super_admin (+ read-only viewer): /admin/group-chat is
  // an admin screen, and the console is super_admin-only now, so a plain
  // 'admin' must not be able to read a batch's chat by calling the API once
  // the screen is gone. An admin who is themselves ENROLLED in the batch
  // still passes on the isOwnBatch branch, as a member — which is correct.
  return role === "super_admin" || role === "viewer" || isOwnBatch;
}

/**
 * May this session POST into a batch's group discussion?
 *
 * 'viewer' can read (read-only admin, same as everywhere else) but not
 * post — matching what "viewer" means throughout this app.
 */
export function canPostGroupChat(role: Role, isOwnBatch: boolean): boolean {
  return role === "super_admin" || isOwnBatch;
}

// Chat-message moderation (deleting one message) has no function here: it's
// gated by requireAdmin directly at the route. There's no extra fact beyond
// role to encode, so a wrapper here would just duplicate that check.

/**
 * Batch-scoped admin isolation.
 * 
 * Super admins bypass (platform-wide access).
 * Normal admins must have a row in admin_batch_assignments for the batch.
 * Fails closed: if the table doesn't exist or query fails, normal admins get no access.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Get the batch IDs assigned to an admin.
 * Returns null for super_admin (unlimited access).
 * Returns empty array for normal admins with no assignments (or on error).
 */
export async function adminBatchIds(
  db: SupabaseClient,
  adminId: string,
  role: string,
): Promise<string[] | null> {
  if (role === "super_admin") return null; // null = all batches
  try {
    const { data, error } = await db
      .from("admin_batch_assignments")
      .select("batch_id")
      .eq("admin_id", adminId);
    if (error) return []; // fail closed
    return (data ?? []).map((r: { batch_id: string }) => r.batch_id);
  } catch {
    return []; // fail closed
  }
}

/**
 * Check if an admin can access a specific batch.
 * Super admins always can. Normal admins need an assignment row.
 */
export async function canAdminAccessBatch(
  db: SupabaseClient,
  adminId: string,
  role: string,
  batchId: string,
): Promise<boolean> {
  if (role === "super_admin") return true;
  try {
    const { data, error } = await db
      .from("admin_batch_assignments")
      .select("batch_id")
      .eq("admin_id", adminId)
      .eq("batch_id", batchId)
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}
