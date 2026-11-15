import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ok, serverError } from "@/lib/api-response";

/** Public endpoint for active engineering colleges only. */
export async function GET(_req: NextRequest) {
  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("colleges")
      .select("id, name")
      .eq("active", true)
      .eq("institution_type", "engineering")
      .order("name");
    if (error) throw error;
    return ok(data ?? []);
  } catch (err) {
    console.error("[api/settings/colleges]", err);
    return serverError();
  }
}
