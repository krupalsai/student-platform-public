import { randomBytes, createHash } from "crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/services/students";
import { invalidateActiveCollegesCache } from "@/lib/services/colleges";

const TTL_MINUTES = 15;

export async function issueCollegeSelectionToken(db: SupabaseClient, phone: string, collegeId: string, collegeName: string): Promise<string> {
  const raw = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();
  const { error } = await db.from("whatsapp_college_selection_tokens").insert({
    token_hash: tokenHash, phone: normalizePhone(phone), college_id: collegeId,
    college_name: collegeName, expires_at: expiresAt,
  });
  if (error) throw error;
  return raw;
}

async function persistSelectedCollege(db: SupabaseClient, collegeId: string, collegeName: string): Promise<boolean> {
  const { error } = await db.from("colleges").upsert({
    id: collegeId,
    name: collegeName,
    active: true,
    institution_type: "engineering",
  }, { onConflict: "id" });
  if (error) {
    console.error("[college-selection] failed to activate selected college", error);
    return false;
  }
  // getActiveColleges() is now cached (services/colleges.ts) — a student who
  // just activated a college via the search flow reads that same list a few
  // lines later in the SAME request (router.ts), so a stale cache here would
  // make their just-selected college look unsupported.
  invalidateActiveCollegesCache();
  return true;
}

export async function consumeCollegeSelectionToken(db: SupabaseClient, phone: string, raw: string): Promise<{ collegeId: string; collegeName: string } | null> {
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const { data } = await db.from("whatsapp_college_selection_tokens")
    .select("id, phone, college_id, college_name, expires_at, consumed_at")
    .eq("token_hash", tokenHash).maybeSingle();
  if (!data || data.consumed_at || new Date(data.expires_at) <= new Date()) return null;
  if (normalizePhone(data.phone) !== normalizePhone(phone)) return null;
  if (!(await persistSelectedCollege(db, data.college_id, data.college_name))) return null;
  const { data: consumed } = await db.from("whatsapp_college_selection_tokens")
    .update({ consumed_at: new Date().toISOString() }).eq("id", data.id).is("consumed_at", null).select("id").maybeSingle();
  return consumed ? { collegeId: data.college_id, collegeName: data.college_name } : null;
}

/** Consume the latest unexpired selection for this WhatsApp number and exact college name. */
export async function consumeLatestCollegeSelection(
  db: SupabaseClient,
  phone: string,
  collegeName: string,
): Promise<{ collegeId: string; collegeName: string } | null> {
  const { data } = await db.from("whatsapp_college_selection_tokens")
    .select("id, phone, college_id, college_name, expires_at, consumed_at")
    .eq("phone", normalizePhone(phone))
    .eq("college_name", collegeName)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  if (!(await persistSelectedCollege(db, data.college_id, data.college_name))) return null;
  const { data: consumed } = await db.from("whatsapp_college_selection_tokens")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", data.id)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  return consumed ? { collegeId: data.college_id, collegeName: data.college_name } : null;
}
