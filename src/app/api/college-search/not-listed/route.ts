import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { notifyAdminOfCollegeRequest } from "@/lib/whatsapp/admin";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const phone = String(body.phone ?? "").trim();
    const collegeName = String(body.collegeName ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    const explicitNotListed = body.explicitNotListed === true;
    // Hard safety gate: only the explicit "My college is not listed" action
    // may create a review request or notify SUPER_ADMIN.
    if (!explicitNotListed) {
      return NextResponse.json({ error: "Explicit not-listed submission required" }, { status: 400 });
    }

    if (!phone || !collegeName) {
      return NextResponse.json({ error: "Phone and college name are required" }, { status: 400 });
    }

    const db = createServiceClient();
    const { error } = await db.from("college_requests").insert({
      phone,
      college_name: collegeName,
      status: "pending",
    });

    if (error) {
      console.error("[college-search/not-listed] save failed", error);
      return NextResponse.json({ error: "Unable to submit college request" }, { status: 500 });
    }

    // Manual "not listed" submissions are a separate, explicit college-review
    // event. Never run the online title/entity lookup against this free-text
    // field: values such as "I want to talk" are not college names.
    await notifyAdminOfCollegeRequest(db, collegeName, phone, [{
      name: collegeName,
      description: null,
      website: null,
      wikipediaUrl: null,
      source: "Student manually entered this name as a college not found in the directory",
    }]).catch((notifyError) => {
      console.error("[college-search/not-listed] admin notification failed", notifyError);
    });

    return NextResponse.json({ ok: true, status: "pending_verification" });
  } catch (e) {
    console.error("[college-search/not-listed] request failed", e);
    return NextResponse.json({ error: "Unable to submit college request" }, { status: 500 });
  }
}
