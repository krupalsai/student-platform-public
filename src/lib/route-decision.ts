// route-decision.ts
//
// THE single source of truth for "where should this person land after
// authenticating." Every page that needs to redirect a user (HomeRedirect,
// dashboard, admin, register) imports and calls this — none of them decide
// on their own anymore. If this logic ever needs to change, it changes in
// exactly one place.

export type Destination = "/admin" | "/register" | "/dashboard";

export function decideDestination(profile: {
  role: string;
  is_profile_complete: boolean;
}): Destination {
  if (profile.role === "admin" || profile.role === "viewer" || profile.role === "super_admin") return "/admin";
  if (!profile.is_profile_complete) return "/register";
  return "/dashboard";
}

/**
 * Whether this account may open the STUDENT side of the app.
 *
 * `decideDestination` above answers "where do they land by default", and for
 * staff that is correctly /admin — running the platform is their main job.
 * This answers a different question: may they ALSO go and look at their own
 * registration?
 *
 * A person can be both. `profiles.role` is one column, so promoting a student
 * to admin overwrites `student` — and before this existed, the role guard
 * bounced them straight back to /admin from every student page, meaning an
 * admin enrolled in a batch could never pay their own fee, check their own
 * payment status, or take part in their batch's discussion as a member.
 *
 * "Enrolled" is the same rule used everywhere else: assigned to a batch AND
 * finished registering (services/enrollment.ts). A staff account that never
 * registered has no student side to show and is still sent to /admin.
 */
export function canUseStudentView(profile: {
  role: string;
  is_profile_complete: boolean;
  batch_id?: string | null;
}): boolean {
  if (profile.role === "student") return true;
  const staff = profile.role === "admin" || profile.role === "super_admin" || profile.role === "viewer";
  return staff && !!profile.batch_id && profile.is_profile_complete;
}
