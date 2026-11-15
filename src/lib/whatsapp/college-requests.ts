import { SupabaseClient } from "@supabase/supabase-js";

export async function saveOtherCollegeRequest(db: SupabaseClient, phone: string, collegeName: string): Promise<boolean> {
  const name = collegeName.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) return false;
  const { error } = await db.from("college_requests").insert({ phone, college_name: name, status: "pending" });
  if (error) { console.error("[college-request] save failed", error); return false; }
  return true;
}
