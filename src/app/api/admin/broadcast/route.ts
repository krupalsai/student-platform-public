import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { sendWhatsAppText } from "@/lib/whatsapp/client";

const Schema = z.object({
  message: z.string().min(1).max(4096),
  batch_id: z.string().uuid().optional(),
  filter: z.enum(["all","approved","pending"]).default("all"),
  attachment_url: z.string().url().optional(),
  attachment_name: z.string().max(200).optional(),
});

export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user || !["admin","super_admin"].includes(user.role))
    return NextResponse.json({ success:false, error:"Admins only" }, { status:403 });

  const body = Schema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ success:false, error:body.error.message }, { status:400 });

  const db = createServiceClient();
  let q = db.from("profiles").select("id, phone").eq("role","student").not("phone","is",null);
  if (body.data.batch_id) q = q.eq("batch_id", body.data.batch_id);
  const { data: profiles, error: profilesErr } = await q;
  if (profilesErr || !profiles) return NextResponse.json({ success:false,error:"Failed to fetch students" }, { status:500 });

  let targets = profiles as {id:string; phone:string}[];
  if (body.data.filter !== "all" && targets.length) {
    const ids = targets.map(p=>p.id);
    const { data: payments } = await db.from("payments").select("student_id,status").in("student_id",ids);
    const payMap: Record<string,string> = {};
    for (const pay of payments ?? []) payMap[pay.student_id] = pay.status;
    targets = targets.filter(p => body.data.filter === "approved" ? payMap[p.id] === "approved" : payMap[p.id] !== "approved");
  }

  const text = body.data.attachment_url
    ? `${body.data.message}\n\n📎 ${body.data.attachment_name || "Attachment"}: ${body.data.attachment_url}`
    : body.data.message;

  let sent=0, failed=0;
  for (const p of targets) {
    try {
      if (await sendWhatsAppText(p.phone, text)) sent++; else failed++;
    } catch { failed++; }
  }

  // Also deliver in-app: a broadcast is expected to reach students inside
  // the app, not only on WhatsApp. Reuse the shared announcement service so
  // it appears on the student dashboard like any other announcement.
  // A failed in-app insert must never fail the WhatsApp send above.
  let inApp = false;
  try {
    const { createAnnouncement } = await import("@/lib/services/announcements");
    let college = "all";
    if (body.data.batch_id) {
      const { data: batch } = await db.from("batches").select("college").eq("id", body.data.batch_id).single();
      if (batch?.college) college = batch.college as string;
    }
    const msg = body.data.message;
    const title = (msg.split("\n")[0] ?? "").trim().slice(0, 100) || "Broadcast";
    await createAnnouncement(db, {
      title,
      body: msg.slice(0, 1000),
      college,
      batch_id: body.data.batch_id ?? null,
      priority: "normal",
      attachment_url: body.data.attachment_url ?? null,
      attachment_name: body.data.attachment_name ?? null,
    }, (user as { profileId?: string }).profileId ?? null, "Broadcast");
    inApp = true;
  } catch (e) {
    console.error("[api/admin/broadcast] in-app announcement failed:", (e as Error).message);
  }

  return NextResponse.json({ success:true, data:{sent,failed,total:targets.length,inApp} });
}
