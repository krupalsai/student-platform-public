import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ok, notFound, serverError } from "@/lib/api-response";

// Public endpoint: returns only what the register / pay pages need to
// display a batch (name, college, fee). UPI details are NOT returned here:
// this route is unauthenticated, so upi_id / upi_name / upi_link were
// exposed to anyone who guessed a batch slug (OWASP API3 excessive data
// exposure, confirmed live 2026-11-06). Payment goes through the gateway
// checkout buttons on /pay/[slug]; no live caller reads UPI fields from
// this endpoint (register and pay pages only use name / fee_amount /
// status / college — verified on main before stripping).
export async function GET(_: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const db = createServiceClient();
    const { data, error } = await db.from("batches")
      .select("id,name,slug,college,fee_amount")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle();

    if (error || !data) return notFound("Batch");

    return ok({
      id: data.id,
      name: data.name,
      slug: data.slug,
      college: data.college,
      fee_amount: data.fee_amount,
    });
  } catch (err) { console.error("[api/batches/by-slug/[slug]]", err);
    return serverError();
  }
}
