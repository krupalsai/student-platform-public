import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, badRequest, forbidden, serverError } from "@/lib/api-response";
import { audit } from "@/lib/audit";
import { searchFaq, recordUnknownQuestion } from "@/lib/services/faq";
import { notifyAdminWhatsApp } from "@/lib/whatsapp/admin";

const schema = z.object({
  message: z.string().trim().min(3, "Please write a bit more detail").max(2000),
});

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  const body = schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return badRequest(body.error.errors[0]?.message ?? "Invalid request");

  try {
    const db = createServiceClient();

    const { data: profile } = await db
      .from("profiles")
      .select("id, phone, college, full_name")
      .eq("id", user!.profileId)
      .maybeSingle();

    const { data: row, error: insertErr } = await db.from("student_queries").insert({
      student_id: user!.profileId,
      name: profile?.full_name ?? null,
      message: body.data.message,
    }).select("id").single();

    if (insertErr || !row) {
      console.error("Query insert failed:", insertErr);
      return serverError("Could not submit your question. Please try again.");
    }

    await audit("query.submitted", "student_query", row.id, { message: body.data.message }, user!.profileId, "student");

    // FAQ Engine: check the knowledge base before ever bothering an admin.
    const faqMatch = await searchFaq(db, body.data.message);
    if (faqMatch) {
      return ok({ id: row.id, faqAnswer: faqMatch });
    }

    // No confident match — record it (dedupes repeats) instead of
    // notifying on every submission, then alert the admin on WhatsApp.
    const result = await recordUnknownQuestion(db, body.data.message, {
      phone: profile?.phone ?? undefined,
      college: profile?.college ?? undefined,
    });
    if (result.isNew && !result.saveFailed) {
      const { data: uq } = await db
        .from("unknown_questions")
        .select("short_id")
        .eq("id", result.id)
        .maybeSingle();
      await notifyAdminWhatsApp(
        db,
        result.id,
        uq?.short_id ?? null,
        body.data.message,
        profile?.phone ?? "unknown",
        result.occurrenceCount
      );
    }

    return ok({ id: row.id, faqAnswer: null });
  } catch (e: any) {
    console.error("Query submit error:", e);
    return serverError();
  }
}
