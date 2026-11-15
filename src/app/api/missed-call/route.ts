import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/session";
import { ok, forbidden, badRequest, serverError } from "@/lib/api-response";
import { normalizePhone } from "@/lib/services/students";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { isRegisteredOrAdmin, startMissedCallLead } from "@/lib/whatsapp/missed-call-leads";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * POST /api/missed-call — report a missed call to the platform number.
 *
 * Callers: the Android detector app (or any telephony system) with the
 * `x-missed-call-secret` header matching env MISSED_CALL_SECRET, OR an
 * authenticated admin session (the "Simulate missed call" form in
 * /admin/call-leads sends { simulate: true } with the admin's token).
 * See docs/missed-call-leads.md.
 *
 * Creates a missed_call_leads row (30-min dedupe) and WhatsApps the caller
 * the first question. Their replies are collected by the webhook hook in
 * src/lib/whatsapp/missed-call-leads.ts.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.MISSED_CALL_SECRET ?? "";
  const headerSecret = req.headers.get("x-missed-call-secret") ?? "";
  const secretOk = !!secret && headerSecret === secret;

  if (!secretOk) {
    const { error } = await requireAdmin(req);
    if (error) return forbidden();
  }

  let callerRaw = "";
  try {
    const body = await req.json();
    callerRaw = String(body?.caller_phone ?? "");
  } catch {
    return badRequest("JSON body with caller_phone is required.");
  }

  const phone = normalizePhone(callerRaw);
  if (phone.length !== 10) return badRequest("Enter a valid 10-digit mobile number.");

  try {
    const db = createServiceClient();

    // A registered student/admin missing a call is not a "lead" — their
    // replies belong to the normal bot, so don't open a lead chat for them.
    if (await isRegisteredOrAdmin(db, phone)) {
      return ok({ skipped: "registered_number" });
    }

    const { outcome } = await startMissedCallLead(db, phone);
    if (outcome === "missing_table") {
      return NextResponse.json(
        { success: false, error: "missed_call_leads table missing — run the migration" },
        { status: 503 },
      );
    }
    if (outcome === "deduped") return ok({ deduped: true });

    const waSent = await sendWhatsAppText(
      phone,
      "Sorry we missed your call — this is Student Platform. What do you need help with?",
    );
    return ok({ created: true, wa_sent: waSent });
  } catch (e) {
    console.error("[api/missed-call]", e);
    return serverError();
  }
}
