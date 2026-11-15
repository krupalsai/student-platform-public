import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { searchFaq } from "@/lib/services/faq";
import { escalateSupport } from "@/lib/integrations/external-support";

export const maxDuration = 30;

const requestSchema = z.object({
  action: z.enum(["health", "faq", "resolve_student", "create_support_case", "escalate"]),
  studentId: z.string().uuid().optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  message: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(80).optional(),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
  supportQueryId: z.string().uuid().optional(),
});

function authorized(req: NextRequest): boolean {
  const configured = process.env.AI_AGENT_API_KEY;
  if (!configured) return false;
  const supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(supplied && supplied === configured);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: parsed.error.errors[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const body = parsed.data;
  const db = createServiceClient();

  if (body.action === "health") {
    return Response.json({
      ok: true,
      service: "student-platform-ai-support",
      sourceOfTruth: "supabase",
      integrations: {
        hubspot: Boolean(process.env.HUBSPOT_ACCESS_TOKEN),
        asana: Boolean(process.env.ASANA_ACCESS_TOKEN && process.env.ASANA_PROJECT_GID),
        granola: Boolean(process.env.GRANOLA_WEBHOOK_URL),
      },
    });
  }

  if (body.action === "faq") {
    if (!body.message) return Response.json({ ok: false, error: "message is required" }, { status: 400 });
    const answer = await searchFaq(db, body.message);
    return Response.json({
      ok: true,
      verified: Boolean(answer),
      answer: answer ? {
        id: answer.id,
        category: answer.category,
        question: answer.question,
        answer: answer.answer,
      } : null,
      source: answer ? "student_platform_faq" : null,
    });
  }

  if (body.action === "resolve_student") {
    if (!body.phone) return Response.json({ ok: false, error: "phone is required" }, { status: 400 });
    const { data: profile, error } = await db
      .from("profiles")
      .select("id, full_name, phone, college")
      .eq("phone", body.phone)
      .maybeSingle();

    if (error) return Response.json({ ok: false, error: "Student lookup failed" }, { status: 500 });
    if (!profile) return Response.json({ ok: true, found: false });

    // Caller-ID/phone number alone is not proof of identity.
    // This endpoint deliberately returns only identity-safe fields.
    return Response.json({
      ok: true,
      found: true,
      verificationRequired: true,
      student: {
        id: profile.id,
        name: profile.full_name,
        college: profile.college,
      },
    });
  }

  if (!body.message) {
    return Response.json({ ok: false, error: "message is required" }, { status: 400 });
  }

  if (body.action === "create_support_case") {
    const { data: profile } = body.studentId
      ? await db.from("profiles").select("id, full_name, phone, college").eq("id", body.studentId).maybeSingle()
      : { data: null };

    const { data: query, error } = await db.from("student_queries").insert({
      student_id: body.studentId ?? null,
      name: profile?.full_name ?? null,
      message: body.message,
      category: body.category ?? "other",
      priority: body.priority,
      status: "open",
      source: "ai_chat",
      last_message_at: new Date().toISOString(),
      last_sender: "student",
    }).select("id").single();

    if (error || !query) return Response.json({ ok: false, error: "Could not create support case" }, { status: 500 });

    await db.from("student_query_messages").insert({
      query_id: query.id,
      sender: "student",
      author_id: body.studentId ?? null,
      body: body.message,
    });

    return Response.json({ ok: true, supportQueryId: query.id });
  }

  if (body.action === "escalate") {
    const { data: profile } = body.studentId
      ? await db.from("profiles").select("id, full_name, phone, college").eq("id", body.studentId).maybeSingle()
      : { data: null };

    const result = await escalateSupport(db, {
      studentId: body.studentId,
      name: profile?.full_name,
      phone: profile?.phone ?? body.phone,
      issue: body.message,
      category: body.category,
      priority: body.priority,
      supportQueryId: body.supportQueryId,
    });

    return Response.json({
      ok: result.hubspot.ok || result.asana.ok,
      escalated: true,
      result,
    });
  }

  return Response.json({ ok: false, error: "Unsupported action" }, { status: 400 });
}
