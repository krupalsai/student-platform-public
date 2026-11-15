import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { getPaymentGateForBatch } from "@/lib/services/payment-gate";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { user, error } = await requireSession(req);
  if (error || !user) return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });

  try {
    const { slug } = await params;
    const db = createServiceClient();
    const { data: batch } = await db.from("batches")
      .select("id")
      .eq("slug", slug)
      .eq("status", "active")
      .maybeSingle();

    if (!batch) return NextResponse.json({ success: false, error: "This batch is no longer active." }, { status: 404 });

    const gate = await getPaymentGateForBatch(db, batch.id);
    return NextResponse.json({ success: true, data: gate });
  } catch (e) {
    console.error("[api/payment-gate/[slug]]", e);
    return NextResponse.json({ success: false, error: "Could not determine payment status." }, { status: 500 });
  }
}
