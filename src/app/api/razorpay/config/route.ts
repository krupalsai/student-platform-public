import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";
import { isRazorpayEnabled } from "@/lib/services/payment-settings";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });

  const db = createServiceClient();
  if (!(await isRazorpayEnabled(db))) {
    return NextResponse.json({ success: false, error: "Razorpay payment is currently disabled." }, { status: 409 });
  }

  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  if (!keyId) {
    return NextResponse.json({ success: false, error: "Razorpay public key is not configured." }, { status: 500 });
  }

  // Key IDs are public checkout identifiers; never expose the API secret.
  return NextResponse.json({ success: true, key_id: keyId }, { headers: { "Cache-Control": "no-store" } });
}
