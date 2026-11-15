import { SupabaseClient } from "@supabase/supabase-js";

export interface College {
  id: string;
  name: string;
  active: boolean;
  institution_type: "engineering";
  search_aliases: string[];
}

// Read on nearly every WhatsApp message that reaches the registration/
// college-matching path (router.ts), so an uncached call here is a DB round
// trip on a table that changes only when an admin runs ADD COLLEGE — a rare
// event. Short TTL, and explicitly invalidated by addCollege() below so a
// newly-added/reactivated college is usable immediately, not after the TTL.
let activeCollegesCache: { value: College[]; expiresAt: number } | null = null;
const ACTIVE_COLLEGES_CACHE_TTL_MS = 60 * 1000;

export function invalidateActiveCollegesCache(): void {
  activeCollegesCache = null;
}

/**
 * The Student Platform college directory is the only source of truth for
 * college selection. It is deliberately restricted to active engineering
 * colleges. Do not fall back to batches or external entity/web search here:
 * those sources can contain unrelated entities such as metro stations,
 * people, researchers, etc.
 */
export async function getActiveColleges(db: SupabaseClient): Promise<College[]> {
  const now = Date.now();
  if (activeCollegesCache && activeCollegesCache.expiresAt > now) return activeCollegesCache.value;

  const { data, error } = await db
    .from("colleges")
    .select("id, name, active, institution_type, search_aliases")
    .eq("active", true)
    .eq("institution_type", "engineering")
    .order("name");

  if (error) {
    console.error("[colleges] failed to load engineering college directory", error);
    return [];
  }

  const colleges = (data ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    active: Boolean(row.active),
    institution_type: "engineering" as const,
    search_aliases: Array.isArray(row.search_aliases)
      ? row.search_aliases.map(String)
      : [],
  }));
  activeCollegesCache = { value: colleges, expiresAt: now + ACTIVE_COLLEGES_CACHE_TTL_MS };
  return colleges;
}

/** Engineering college ids as a plain string array — used for Zod validation. */
export async function getCollegeIds(db: SupabaseClient): Promise<string[]> {
  const colleges = await getActiveColleges(db);
  return colleges.map((c) => c.id);
}

/**
 * Every engineering college id in the directory, active or not — used for
 * existence validation on admin PATCH routes (batches/[id], students/[id]).
 * A batch or student already belonging to an inactive college (e.g. BIET)
 * must still be editable: active-only validation rejects the update with
 * "Unknown college." even though the college row exists. Deliberately
 * uncached — this is an admin write-path check, not a hot read.
 */
export async function getAllCollegeIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from("colleges")
    .select("id")
    .eq("institution_type", "engineering");

  if (error) {
    console.error("[colleges] failed to load all college ids", error);
    return [];
  }
  return (data ?? []).map((row) => String(row.id));
}

/**
 * Adds a college to the supported list, or re-activates one already there.
 *
 * Exists because the "College not listed — review required" alert tells an
 * admin to "add it to the supported-college list" and there was no way to do
 * that from WhatsApp. An admin replying "Add then" to that alert got a request
 * for clarification, because nothing could act on it — the same shape of gap
 * as an alert naming a command that does not exist.
 *
 * Re-activating rather than erroring on an existing row matters: the AICTE
 * "not listed" flow has already inserted ~22 inactive rows, so the college an
 * admin is asked to approve frequently exists already with active=false.
 *
 * `code` is the optional short code (2–10 letters, e.g. SNIST) the admin
 * wants as the college id. Without it the id is derived from the name, as
 * before. A code already used by a different college is rejected in plain
 * words — the id is the key the batch and registration flows join on.
 */
export async function addCollege(
  db: SupabaseClient,
  name: string,
  code?: string,
): Promise<{ ok: true; id: string; reactivated: boolean } | { ok: false; reason: string }> {
  const clean = name.trim().replace(/\s+/g, " ");
  if (clean.length < 2) return { ok: false, reason: "That name is too short." };
  if (clean.length > 120) return { ok: false, reason: "That name is too long." };

  const shortCode = code?.trim().toUpperCase() ?? "";
  if (shortCode && !/^[A-Z]{2,10}$/.test(shortCode)) {
    return { ok: false, reason: "The short code should be 2–10 letters, like GNIT." };
  }

  // Match on id or name, case-insensitively — an admin types "Gnits", the row
  // may be "GNITS" or "G. Narayanamma Institute of Technology and Science".
  const { data: existing } = await db
    .from("colleges")
    .select("id, name, active")
    .or(`id.ilike.${clean},name.ilike.${clean}`)
    .maybeSingle();

  if (existing) {
    if (existing.active) return { ok: false, reason: `${existing.name} is already active.` };
    const { error } = await db
      .from("colleges")
      .update({ active: true, institution_type: "engineering" })
      .eq("id", existing.id);
    if (error) return { ok: false, reason: error.message };
    invalidateActiveCollegesCache();
    return { ok: true, id: existing.id, reactivated: true };
  }

  // An explicit short code must not belong to a different college.
  if (shortCode) {
    const { data: clash } = await db
      .from("colleges")
      .select("id, name")
      .eq("id", shortCode)
      .maybeSingle();
    if (clash && String(clash.name).toLowerCase() !== clean.toLowerCase()) {
      return { ok: false, reason: `${shortCode} is already used by ${clash.name}. Pick a different short code.` };
    }
  }

  // A new row needs an id. Short acronym-style names are used as-is (GNIT,
  // BIET, GNITS all follow that convention); anything longer gets a slug, so
  // a full institution name never becomes an unusable id.
  const id = shortCode
    ? shortCode
    : /^[A-Za-z]{2,10}$/.test(clean)
      ? clean.toUpperCase()
      : clean.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

  const { error } = await db.from("colleges").insert({
    id,
    name: clean,
    active: true,
    institution_type: "engineering",
    // Insert ONLY columns that exist on the live colleges table (id, name,
    // active, created_at, institution_type, search_aliases). Migration 0074
    // added college_code / normalized_name, but they were never applied to
    // production — inserting them fails with "Could not find the
    // 'college_code' column of 'colleges' in the schema cache" (live
    // incident 11 Nov 2026: ADD COLLEGE CMR TECHNICAL CAMPUS failed twice).
    // The id itself is the join key; the aliases make the college findable
    // by its full name and its short code.
    search_aliases: Array.from(new Set([clean, id])),
  });
  if (error) return { ok: false, reason: error.message };
  invalidateActiveCollegesCache();
  return { ok: true, id, reactivated: false };
}

/** Display name for a single engineering college id. */
export async function getCollegeName(db: SupabaseClient, id: string): Promise<string> {
  const { data } = await db
    .from("colleges")
    .select("name")
    .eq("id", id)
    .eq("institution_type", "engineering")
    .maybeSingle();

  return data?.name ?? id;
}
