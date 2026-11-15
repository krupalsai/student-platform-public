import { NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/session";
import { ok, forbidden, serverError, dbError, tooManyRequests } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { isVoiceCallsEnabled } from "@/lib/services/payment-settings";
import { canPlaceCall, canAnswerCalls, settleStaleCalls } from "@/lib/services/voice-calls";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";
import { notifyStudent } from "@/lib/services/student-notifications";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const MAX_REASON_LEN = 200;
const RESUME_MAX_AGE_SECS = 5 * 60;

/**
 * Tell the admins a student is ringing, right now.
 *
 * The admin console polls for incoming calls, but an admin with the console
 * closed would never see one — and a call nobody knows about is the whole
 * problem this feature exists to solve. So WhatsApp carries the alert, the
 * same channel every other "an admin needs to act" notification here uses.
 *
 * Fire-and-forget on purpose: a WhatsApp outage must not stop the call from
 * being placed, because an admin who DOES have the console open can still
 * answer it.
 */
async function alertAdmins(
  db: ReturnType<typeof createServiceClient>,
  studentName: string,
  studentPhone: string | null,
  batchName: string | null,
  reason: string | null,
): Promise<void> {
  try {
    const phones = await getActiveAdminPhones(db);
    if (!phones.length) return;
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev").replace(/\/$/, "");
    const text =
      `📞 *Incoming call in the Student App*\n\n` +
      `*Student:* ${studentName}\n` +
      (batchName ? `*Batch:* ${batchName}\n` : ``) +
      (studentPhone ? `*Phone:* ${studentPhone}\n` : ``) +
      (reason ? `*About:* ${reason}\n` : ``) +
      `\nOpen ${appUrl}/admin to answer. It rings for 60 seconds.`;
    await Promise.all(phones.map(p => sendWhatsAppText(normalizeWhatsAppNumber(p), text)));
  } catch (e) {
    console.error("[api/calls] admin alert failed:", (e as Error).message);
  }
}

/** Student places a call. */
export async function POST(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const db = createServiceClient();

  // Super-admin callback: select a batch + student and ring that student.
  // The target is a student, never a particular admin; student-originated calls
  // are still offered to every active super_admin.
  const body = await req.clone().json().catch(() => ({} as Record<string, unknown>));
  if (body?.action === "callback") {
    if (user!.role !== "super_admin") return forbidden();
    const batchId = typeof body.batchId === "string" ? body.batchId : "";
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    if (!batchId || !studentId) return forbidden();

    const rl = await checkRateLimit(db, `voice_callback:${user!.profileId}`, 20, 300);
    if (!rl.allowed) return tooManyRequests("You've started several callbacks. Please wait a few minutes.");

    try {
      await settleStaleCalls(db);
      const [{ data: student }, { data: batch }] = await Promise.all([
        db.from("profiles")
          .select("id, full_name, phone, batch_id, is_profile_complete, role")
          .eq("id", studentId)
          .maybeSingle(),
        db.from("batches").select("id, name").eq("id", batchId).maybeSingle(),
      ]);
      if (!student || student.batch_id !== batchId || student.role !== "student" || student.is_profile_complete !== true) {
        return forbidden();
      }
      if (!batch) return forbidden();

      const { data: active } = await db
        .from("voice_calls")
        .select("id, status, created_at, batch_id, admin_id")
        .eq("student_id", studentId)
        .in("status", ["ringing", "accepted"])
        .limit(1)
        .maybeSingle();
      if (active) {
        const ageSecs = (Date.now() - new Date(active.created_at).getTime()) / 1000;
        if (ageSecs <= RESUME_MAX_AGE_SECS) return ok({ call: active, resumed: true });
        // A browser/network crash can leave an accepted call open forever because
        // there is no server-side WebRTC connection state. Never trap the student
        // behind a dead accepted row; a fresh callback gets a fresh SFU session.
        await db.from("voice_calls").update({
          status: "ended",
          ended_at: new Date().toISOString(),
          ended_by: "stale",
        }).eq("id", active.id).in("status", ["ringing", "accepted"]);
      }

      const { data: call, error: err } = await db
        .from("voice_calls")
        .insert({
          student_id: studentId,
          batch_id: batchId,
          admin_id: user!.profileId,
          reason: "Admin callback",
          status: "ringing",
        })
        .select("id, status, created_at, batch_id, admin_id, student_id")
        .single();
      if (err) return dbError("api/calls callback", err);

      /**
       * Without this, an admin callback rang for nobody: the student had no
       * out-of-band alert of any kind — no WhatsApp, no push, nothing — and
       * the in-app banner (StudentCallButton) only shows if they already have
       * the app open and polling. Confirmed live: a run of admin callbacks in
       * prod, none ever reached `accepted` — every one timed out or was hung
       * up by the caller, exactly this gap. Fire-and-forget, same reasoning
       * as alertAdmins below: a notification outage must not stop the call
       * itself from being placed.
       */
      void notifyStudent(
        db,
        student.id,
        "voice_call",
        `📞 An admin from Student Platform is calling you.\n\nOpen the Student App to answer. It rings for 60 seconds.`,
        call.id,
        { nativeCall: { callerName: "An admin from Student Platform" } },
      ).catch((e) => console.error("[api/calls callback] student alert failed:", (e as Error).message));

      return ok({
        call,
        student: { id: student.id, name: student.full_name ?? "Student", phone: student.phone ?? null },
        batch: { id: batch.id, name: batch.name },
      });
    } catch (e) {
      console.error("[api/calls callback]", e);
      return serverError();
    }
  }

  if (!(await isVoiceCallsEnabled(db))) {
    return ok({ disabled: true, call: null });
  }
  if (!canPlaceCall(user!.role, user!.isProfileComplete, user!.batchId)) return forbidden();

  // 5 calls per 5 minutes. A student redialling after a genuine drop is normal;
  // ringing every admin's WhatsApp in a loop is not.
  const rl = await checkRateLimit(db, `voice_call:${user!.profileId}`, 5, 300);
  if (!rl.allowed) return tooManyRequests("You've placed several calls just now. Please wait a few minutes before trying again.");

  try {
    await settleStaleCalls(db);

    // Never open a second line for the same student. Redialling while a call is
    // already live would leave an orphaned row ringing in the admin console.
    const { data: existing } = await db
      .from("voice_calls")
      .select("id, status, created_at, batch_id")
      .eq("student_id", user!.profileId)
      .in("status", ["ringing", "accepted"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      const ageSecs = (Date.now() - new Date(existing.created_at).getTime()) / 1000;
      if (ageSecs <= RESUME_MAX_AGE_SECS) return ok({ call: existing, resumed: true });
      // Do not resurrect an accepted call left behind by a crashed/closed
      // browser. It has no live SFU session anymore.
      await db.from("voice_calls").update({
        status: "ended",
        ended_at: new Date().toISOString(),
        ended_by: "stale",
      }).eq("id", existing.id).in("status", ["ringing", "accepted"]);
    }

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_REASON_LEN) || null : null;

    const { data: profile } = await db
      .from("profiles")
      .select("full_name, phone, batch_id")
      .eq("id", user!.profileId)
      .maybeSingle();

    const { data: call, error: err } = await db
      .from("voice_calls")
      .insert({
        student_id: user!.profileId,
        batch_id: profile?.batch_id ?? user!.batchId ?? null,
        reason,
        status: "ringing",
      })
      .select("id, status, created_at, batch_id")
      .single();
    if (err) return dbError("api/calls POST", err);

    let batchName: string | null = null;
    if (profile?.batch_id) {
      const { data: batch } = await db.from("batches").select("name").eq("id", profile.batch_id).maybeSingle();
      batchName = batch?.name ?? null;
    }
    void alertAdmins(db, profile?.full_name ?? "A student", profile?.phone ?? null, batchName, reason);

    return ok({ call, resumed: false });
  } catch (e) {
    console.error("[api/calls POST]", e);
    return serverError();
  }
}

/**
 * GET — what each side needs to know about calls in flight.
 *
 * Admin: every call currently ringing, so the console can present them.
 * Student: their own live call, so a refreshed tab rejoins instead of stranding.
 */
export async function GET(req: NextRequest) {
  const { user, error } = await requireSession(req);
  if (error) return forbidden();
  const db = createServiceClient();

  try {
    await settleStaleCalls(db);

    if (canAnswerCalls(user!.role)) {
      const { data, error: err } = await db
        .from("voice_calls")
        .select("id, student_id, batch_id, reason, status, created_at")
        .eq("status", "ringing")
        .is("admin_id", null)
        .order("created_at", { ascending: true })
        .limit(10);
      if (err) return dbError("api/calls GET", err);

      const calls = data ?? [];
      if (!calls.length) return ok({ calls: [] });

      // Decorate with who is calling. Two small lookups rather than a view:
      // this runs on a poll, and the id lists are bounded at 10.
      const studentIds = [...new Set(calls.map(c => c.student_id))];
      const batchIds = [...new Set(calls.map(c => c.batch_id).filter(Boolean))] as string[];
      const [{ data: profiles }, { data: batches }] = await Promise.all([
        db.from("profiles").select("id, full_name, phone").in("id", studentIds),
        batchIds.length
          ? db.from("batches").select("id, name").in("id", batchIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      ]);
      const nameOf = new Map((profiles ?? []).map(p => [p.id, p]));
      const batchOf = new Map((batches ?? []).map(b => [b.id, b.name]));

      return ok({
        calls: calls.map(c => ({
          ...c,
          student_name: nameOf.get(c.student_id)?.full_name ?? "Student",
          student_phone: nameOf.get(c.student_id)?.phone ?? null,
          batch_name: c.batch_id ? batchOf.get(c.batch_id) ?? null : null,
        })),
      });
    }

    const { data, error: err } = await db
      .from("voice_calls")
      .select("id, status, created_at, answered_at, batch_id, admin_id")
      .eq("student_id", user!.profileId)
      .in("status", ["ringing", "accepted"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (err) return dbError("api/calls GET student", err);
    let admin: { full_name: string | null } | null = null;
    if (data?.admin_id) {
      const { data: adminProfile } = await db.from("profiles").select("full_name").eq("id", data.admin_id).maybeSingle();
      admin = adminProfile ? { full_name: adminProfile.full_name ?? null } : null;
    }
    return ok({ call: data ?? null, admin });
  } catch (e) {
    console.error("[api/calls GET]", e);
    return serverError();
  }
}
