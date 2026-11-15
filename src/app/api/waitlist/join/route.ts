import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { joinWaitlist, getWaitlistCount } from "@/lib/services/waitlist";
import { notifyAdminOfWaitlistJoin } from "@/lib/whatsapp/admin";
import { getCollegeName } from "@/lib/services/colleges";
import { ok, forbidden, serverError } from "@/lib/api-response";

interface JoinBody { college?: string }

/**
 * POST /api/waitlist/join
 *
 * Website equivalent of the WhatsApp "no active batch → join waitlist"
 * path — same joinWaitlist()/getWaitlistCount()/notifyAdminOfWaitlistJoin()
 * used there, just triggered from the registration page instead of a
 * WhatsApp button tap. Used when a signed-in student has no active batch
 * (their college's batch closed/archived after they registered, or a
 * website registration token's batch closed between issuance and use)
 * so they never hit a dead end — same guarantee the WhatsApp flow already
 * has.
 */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();

  try {
    const db = createServiceClient();
    const { data: profile } = await db.from("profiles").select("phone, college").eq("id", user!.profileId).maybeSingle();

    // A student who never opened a batch link (plain phone/OTP /login) has
    // no college on their profile yet — the register page's college picker
    // passes one explicitly in that case. Still validated against the real
    // colleges table so an arbitrary string can't create a bogus queue.
    let college = profile?.college ?? null;
    if (!college) {
      const body = (await req.json().catch(() => ({}))) as JoinBody;
      if (body.college) {
        const { data: row } = await db.from("colleges").select("id").eq("id", body.college).eq("active", true).maybeSingle();
        if (row) college = row.id;
      }
    }

    if (!college || !profile?.phone) {
      return NextResponse.json(
        { success: false, error: "We don't have enough information to add you to a waiting list. Please contact support." },
        { status: 409 }
      );
    }

    const { alreadyWaiting, position } = await joinWaitlist(db, college, profile.phone);

    if (!alreadyWaiting) {
      const collegeName = await getCollegeName(db, college);
      const waitingCount = await getWaitlistCount(db, college);
      await notifyAdminOfWaitlistJoin(db, collegeName, waitingCount, waitingCount === 1);
    }

    return ok({ alreadyWaiting, position });
  } catch (e) {
    console.error("[api/waitlist/join]", e);
    return serverError();
  }
}
