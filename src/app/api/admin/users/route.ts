import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError } from "@/lib/api-response";

export async function GET(req: NextRequest) {
  const { error } = await requireSuperAdmin(req);
  if (error) return forbidden();
  const db = createServiceClient();
  const { data, error: err } = await db
    .from("profiles")
    .select("id,full_name,username,phone,college,role,is_profile_complete,created_at,batch_id,batches!profiles_batch_id_fkey(name)")
    .in("role", ["admin", "viewer", "super_admin"])   // ← students excluded
    .order("role", { ascending: false })
    .order("created_at", { ascending: false });
  if (err) return serverError();
  return ok(data ?? []);
}
