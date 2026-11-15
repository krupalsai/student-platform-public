import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";

const Schema = z.object({
  message: z.string().min(1).max(4096),
});

/**
 * POST /api/admin/ops-digest — a thin relay: hands pre-composed text to
 * every active WhatsApp admin, reusing the exact send mechanism
 * `proactive-nudges.ts`'s question-escalation sweep already uses
 * (`getActiveAdminPhones` + `sendWhatsAppText`), not a new one.
 *
 * Built for the daily ops-digest Routine: the digest itself is composed
 * OUTSIDE this app (a Claude Code session reading Supabase/GitHub/Vercel
 * through its own already-trusted, scoped MCP connections — no new
 * production secret was added anywhere to get GitHub/Vercel visibility).
 * This route's only job is the one piece that session can't do itself:
 * put text on the same WhatsApp number the rest of the admin alerts use.
 * super_admin only, same tier as every other admin-broadcast-shaped route
 * (item #110) — this sends to every admin, so it's not a lesser action
 * than `whatsapp-broadcast`, just a different source of the text.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error || !user) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  if (user.role !== "super_admin") return NextResponse.json({ success: false, error: "Admins only" }, { status: 403 });

  const body = Schema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ success: false, error: body.error.message }, { status: 400 });

  const db = createServiceClient();
  const phones = await getActiveAdminPhones(db);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    phones.map((p) =>
      sendWhatsAppText(normalizeWhatsAppNumber(p), body.data.message)
        .then((ok) => { if (ok) sent++; else failed++; })
        .catch(() => { failed++; }),
    ),
  );

  await audit("ops_digest.sent", "platform", null, { sent, failed, recipients: phones.length }, user.profileId, "admin");

  return NextResponse.json({ success: true, data: { sent, failed, recipients: phones.length } });
}
