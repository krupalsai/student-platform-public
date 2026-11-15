import { createClient } from "@supabase/supabase-js";

function getSupabaseConfig(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    // Keep the failure at request time rather than module-import/build time.
    // Preview deployments may intentionally omit production-only secrets, but
    // any server route that actually needs Supabase must still fail loudly.
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL — set both in environment variables (Vercel Project Settings → Environment Variables)."
    );
  }

  return { url, serviceRoleKey };
}

export function createServiceClient() {
  const { url, serviceRoleKey } = getSupabaseConfig();
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
