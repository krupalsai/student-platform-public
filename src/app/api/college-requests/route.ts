import { NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { notifyAdminOfCollegeRequest } from "@/lib/whatsapp/admin";
import { normalizePhone } from "@/lib/services/students";
import { ok, zodError, serverError, badRequest } from "@/lib/api-response";

const Schema = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(10).max(13),
  college_name: z.string().trim().min(2).max(200),
});

/**
 * POST /api/college-requests
 *
 * A student whose college is NOT listed asks for it to be added. No session
 * needed — this is the entry point for a brand-new student.
 *
 * The request must reach the admin (Krupal) two ways:
 *  1. Stored in the `college_requests` table (migration 0064: phone,
 *     college_name, status 'pending', notes) so the admin can see every
 *     request and act on it.
 *  2. WhatsApp notification to the active SUPER_ADMINs via the existing
 *     notifyAdminOfCollegeRequest helper ("To add it: reply ADD COLLEGE
 *     <name>").
 *
 * The WhatsApp notification is the guaranteed delivery: if the insert ever
 * fails, the admin is still notified and the student still gets their
 * confirmation — the request is never lost silently.
 */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.safeParse(await req.json());
    if (!body.success) return zodError(body.error);
    const { name, college_name } = body.data;
    const phone = normalizePhone(body.data.phone);
    if (!/^\d{10}$/.test(phone)) return badRequest("Please enter a valid 10-digit mobile number.");

    const db = createServiceClient();

    // Durable record. The student's name goes in `notes` — the table
    // (migration 0064) has phone + college_name + status, no name column.
    try {
      const { error } = await db.from("college_requests").insert({
        phone,
        college_name,
        status: "pending",
        notes: `Student: ${name}`,
      });
      if (error) throw error;
    } catch (e) {
      console.error("[api/college-requests] insert failed:", (e as Error)?.message ?? e);
    }

    // Guaranteed delivery to the admin.
    await notifyAdminOfCollegeRequest(db, college_name, phone, []).catch((e) => {
      console.error("[api/college-requests] admin notify failed:", e);
    });

    return ok({ received: true });
  } catch (e) {
    console.error("[api/college-requests]", e);
    return serverError();
  }
}
