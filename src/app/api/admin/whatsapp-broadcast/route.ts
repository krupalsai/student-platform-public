import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { broadcastWhatsApp, broadcastWhatsAppToBatch } from "@/lib/whatsapp/broadcast";

const Schema = z.object({
  message: z.string().min(1).max(4096),
  // Omitted → whole-platform broadcastWhatsApp (whatsapp_moderation, every
  // contact who's ever messaged the bot). Present → scoped to that one
  // batch's own enrolled students only (broadcastWhatsAppToBatch) — the
  // correct default for anything that names a specific batch, since a
  // platform-wide send put a GNITC Batch 1 payment message in front of a
  // BIET waitlist student. "broadcast has to be batch wise not to everyone."
  batch_id: z.string().uuid().optional(),
});

/**
 * POST /api/admin/whatsapp-broadcast — the missing API route for
 * broadcastWhatsApp / broadcastWhatsAppToBatch (item #109: WhatsApp
 * broadcast existed only as a WhatsApp admin text command, "BROADCAST
 * <message>", which is platform-wide only — there was never a batch-scoped
 * text command or API caller at all).
 *
 * Deliberately a thin wrapper, not a reimplementation: same recipient
 * resolution, same 24h-window/template split, same restricted-contact skip
 * as whichever function it calls. Nothing about delivery behavior changes;
 * only the trigger surface (and, with batch_id, the scoping) does.
 *
 * super_admin only, matching the rest of the admin console (item #110).
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  if (user.role !== "super_admin") return NextResponse.json({ success: false, error: "Admins only" }, { status: 403 });

  const body = Schema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ success: false, error: body.error.message }, { status: 400 });

  const db = createServiceClient();
  const result = body.data.batch_id
    ? await broadcastWhatsAppToBatch(db, body.data.batch_id, body.data.message)
    : await broadcastWhatsApp(db, body.data.message);

  await audit("whatsapp.broadcast", "platform", body.data.batch_id ?? null, { ...result }, user.profileId, "admin");

  return NextResponse.json({ success: true, data: result });
}
