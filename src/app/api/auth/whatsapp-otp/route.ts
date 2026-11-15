import { setSessionCookie } from "@/lib/session";
import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { consumeAdminLoginOtp } from "@/lib/whatsapp/admin-login";
import { ok, badRequest, serverError, zodError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const Schema = z.object({ otp: z.string().min(10) });

export async function POST(req: NextRequest) {
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const db = createServiceClient();
    const result = await consumeAdminLoginOtp(db, body.data.otp);
    if (!result) return badRequest("This login link is invalid, expired, or already used. Send LOGIN to the WhatsApp bot again for a new one.");

    const res = ok({ token: result.token, profile_id: result.profileId, role: result.role });
    setSessionCookie(res, result.token, result.role);
    return res;
  } catch (e) {
    console.error("[api/auth/whatsapp-otp]", e);
    return serverError();
  }
}
