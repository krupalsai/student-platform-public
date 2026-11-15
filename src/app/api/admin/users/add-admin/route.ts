import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/session";
import { ok, forbidden, serverError, zodError, dbError, badRequest } from "@/lib/api-response";
import { normalizePhone } from "@/lib/services/students";
import { upsertAdmin, WA_ROLE_FOR_WEBSITE_ROLE } from "@/lib/whatsapp/admin-service";

// Adding people through this endpoint can only grant normal admin or viewer access.
// super_admin must never be creatable through the "Add Admin" flow.
const Schema = z.object({
  phone: z.string().min(10).max(15),
  role: z.enum(["admin", "viewer"]),
});

// Phone-based, not Telegram-ID-based (item #65) — the app's actual admin
// login is phone + WhatsApp OTP (app-login.ts), not Telegram. Adding by
// Telegram ID only ever set profiles.role; it never touched the separate
// WhatsApp `admins` table that phone/OTP login also requires (getAdmin()),
// so a Telegram-added admin could be locked out of the phone login entirely.
// This route now writes both in one step — see admin-service.ts's upsertAdmin.
export async function POST(req: NextRequest) {
  try {
    const { user, error } = await requireSuperAdmin(req);
    if (error) return forbidden();

    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);

    const phone = normalizePhone(body.data.phone);
    if (phone.length !== 10) return badRequest("Enter a valid 10-digit mobile number.");

    const { role } = body.data;
    const db = createServiceClient();

    const { data: existing, error: findErr } = await db.from("profiles")
      .select("id, role")
      .eq("phone", phone)
      .maybeSingle();
    if (findErr) return dbError("add-admin profiles lookup", findErr, "Profile lookup failed. Please try again.");

    if (existing) {
      const { error: upErr } = await db.from("profiles").update({ role }).eq("id", existing.id);
      if (upErr) return dbError("add-admin promote", upErr, "Failed to update role. Please try again.");
    } else {
      // Unlike the old Telegram-ID flow, we can create the profile outright
      // here — phone is the real, permanent identifier the person will log
      // in with, so there's nothing to "fill in later" on first login.
      const { error: insErr } = await db.from("profiles").insert({ phone, role });
      if (insErr) return dbError("add-admin create", insErr, "Failed to create profile. Please try again.");
    }

    // Required for phone/OTP admin login to actually work — see the comment
    // on upsertAdmin.
    await upsertAdmin(db, phone, WA_ROLE_FOR_WEBSITE_ROLE[role], user!.profileId);

    return ok({
      status: "applied",
      message: `${existing ? "Promoted" : "Created"} — granted ${role}, can log in with this phone number now.`,
    });
  } catch (e) {
    console.error("[add-admin] unhandled exception:", e);
    return serverError();
  }
}
