import { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { sendPushMessage } from "@/lib/push/client";
import { deletePushSubscriptionByEndpoint, getPushSubscriptionsForStudent, markPushSubscriptionFailed, touchPushSubscription } from "@/lib/push/subscriptions";
import { sendNativeCallPush } from "@/lib/push/native-fcm";

export async function sendWhatsApp(phone: string, text: string): Promise<boolean> {
  return sendWhatsAppText(phone, text);
}

export async function log(
  db: SupabaseClient,
  studentId: string,
  type: string,
  channel: string,
  message: string,
  referenceId?: string
): Promise<void> {
  try {
    await db.from("student_notifications").insert({
      student_id: studentId, type, channel, message,
      reference_id: referenceId ?? null,
    });
  } catch (e) {
    console.error("[lib/services/student-notifications] log insert failed:", e);
  }
}

/**
 * Web Push is the primary Student App channel. WhatsApp is the automatic
 * fallback for normal student notifications.
 *
 * When a caller explicitly requests a channel, that request is authoritative.
 * In particular, payment approval passes channels:["whatsapp"], so payment
 * approval is sent directly to WhatsApp and is never diverted to Web Push.
 */
/**
 * What a push attempt actually did. `notifyStudent` returns this so callers
 * (announcements, broadcasts) can report REAL delivery — never count a
 * student as "push sent" unless `delivered` is true. `reason` is the
 * machine-readable cause from `sendPushMessage` ("not_configured" /
 * "expired" / "unauthorized" / "push_service_error" / "network_error") and
 * is also written to the server log on every failure, so a dead VAPID key
 * can never again fail silently for weeks.
 */
export interface PushDelivery {
  delivered: boolean;
  /** True when at least one stored subscription was attempted. */
  attempted: boolean;
  subscriptions: number;
  reason?: string;
  statusCode?: number;
}

const NOT_ATTEMPTED: PushDelivery = { delivered: false, attempted: false, subscriptions: 0, reason: "no_subscription" };

async function sendPushFirst(
  db: SupabaseClient,
  studentId: string,
  type: string,
  message: string,
  referenceId?: string,
  url = "/"
): Promise<PushDelivery> {
  try {
    const subscriptions = await getPushSubscriptionsForStudent(db, studentId);
    if (!subscriptions.length) return NOT_ATTEMPTED;

    const title = type === "group_message"
      ? "New message in Batch Discussion"
      : type === "announcement"
        ? "New Student Platform announcement"
        : type === "court_order"
          ? "📄 Court order copy arrived"
          : type === "voice_call"
            ? "📞 Incoming call"
            : "Student Platform update";
    const body = message.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 220);

    /**
     * A voice call is the one notification type where "small message,
     * silently sits there" IS the bug — everything else (a chat message, an
     * announcement) is fine to read at leisure. `requireInteraction` keeps
     * it on screen instead of auto-dismissing in a few seconds; `vibrate` and
     * `renotify` are honoured by the service worker (`public/sw.js`) even
     * while the app itself isn't open, since the OS runs the push handler
     * regardless. `renotify` matters specifically for a retried callback —
     * without it, a second call with the same tag replaces the first
     * silently instead of buzzing again.
     */
    const callExtras = type === "voice_call"
      ? { requireInteraction: true, renotify: true, vibrate: [400, 200, 400, 200, 400] }
      : {};

    /**
     * Chat messages and support replies are shown live (and chimed for) by the
     * screen that owns them. Naming that screen lets the service worker mute
     * the system alert when the student is already looking at it — otherwise
     * the phone's alert and the screen's own pop would sound twice — and tell
     * the screen to refresh at once (`public/sw.js`, `liveOn`).
     */
    const liveOn = type === "group_message" ? "/discussion" : type === "support_reply" ? "/support" : undefined;

    let lastReason: string | undefined;
    let lastStatusCode: number | undefined;
    for (const sub of subscriptions) {
      const result = await sendPushMessage(sub, { title, body, tag: `student-platform-${type}-${referenceId ?? "update"}`, url, ...(liveOn ? { liveOn } : {}), ...callExtras });
      // `dead` covers 404/410 (endpoint gone) AND 401/403 (VAPID mismatch
      // after a key rotation): retrying such a subscription is pointless,
      // so delete it instead of marking it failed and retrying forever.
      if (result.dead) await deletePushSubscriptionByEndpoint(db, sub.endpoint);
      else if (!result.ok) await markPushSubscriptionFailed(db, sub.id, result.reason);
      else await touchPushSubscription(db, sub.id);

      if (result.ok) {
        await log(db, studentId, type, "web_push", message, referenceId);
        return { delivered: true, attempted: true, subscriptions: subscriptions.length };
      }
      // Record the failure — never swallow it. A "not_configured" or
      // "unauthorized" reason on every subscription means the VAPID key
      // pair is wrong, not the students' devices.
      lastReason = result.reason;
      lastStatusCode = result.statusCode;
      console.error("[lib/services/student-notifications] push failed:", studentId, type, result.reason, result.statusCode ?? "");
    }
    return { delivered: false, attempted: true, subscriptions: subscriptions.length, reason: lastReason, statusCode: lastStatusCode };
  } catch (e) {
    console.error("[lib/services/student-notifications] push delivery failed:", e);
  }
  return { delivered: false, attempted: false, subscriptions: 0, reason: "error" };
}

/**
 * Student notifications — policy: WhatsApp is REGISTRATION-ONLY.
 *
 * WhatsApp business messaging costs money per message; the Student App is
 * free. So every notification goes push-first (best effort) and is always
 * written to the in-app inbox (student_notifications), which the student
 * reads at /notifications. The ONLY student type that still uses WhatsApp
 * is "registration" (OTP/login + the app link).
 *
 * The `channels` and `allowTemplateFallback` opts are kept for signature
 * compatibility but no longer cause any WhatsApp send.
 */
export async function notifyStudent(
  db: SupabaseClient,
  studentId: string,
  type: string,
  message: string,
  referenceId?: string,
  opts?: {
    channels?: Array<"telegram" | "whatsapp">;
    url?: string;
    /** voice_call only — feeds the native app's full-screen incoming-call UI. */
    nativeCall?: { callerName: string; reason?: string | null };
    /**
     * Legacy: previously allowed a paid WhatsApp template fallback outside
     * Meta's 24h window. No longer has any effect — see the policy above.
     */
    allowTemplateFallback?: boolean;
  },
): Promise<PushDelivery> {
  // Batch Discussion notifications are strictly Student App notifications.
  // Court-order arrivals are the same: an in-app (push) notification, never
  // a WhatsApp chat message — the push opens the order's soft copy itself.
  // The inbox row is ALWAYS written too: before this fix a failed push
  // meant the message vanished entirely for these two types (no inbox
  // fallback), which is exactly the silent loss this change closes.
  if (type === "group_message" || type === "court_order") {
    const delivery = await sendPushFirst(db, studentId, type, message, referenceId, opts?.url ?? "/");
    await log(db, studentId, type, "inbox", message, referenceId);
    return delivery;
  }

  const { data: profile } = await db
    .from("profiles")
    .select("phone")
    .eq("id", studentId)
    .maybeSingle();
  if (!profile?.phone) return { delivered: false, attempted: false, subscriptions: 0, reason: "no_phone" };

  // REGISTRATION ONLY on WhatsApp: the completion message and the Student
  // App ready note, plus the "everything happens in the app from here" line.
  if (type === "registration") {
    const ok = await sendWhatsApp(profile.phone, message);
    if (ok) await log(db, studentId, type, "whatsapp", message, referenceId);

    // No sign-in link any more (removed 9 Nov 2026): the student opens the
    // installed app and signs in with a code — reply VERIFY here and the
    // bot sends one. Text only, no URL: a link would open in the browser
    // instead of the installed app.
    const appBody =
      "📱 <b>Your Student App is ready!</b>\n\nOpen the Student App on your home screen and sign in with a code — reply *VERIFY* here and I'll send you a 6-digit code to type in the app.\n\nFrom here, everything happens inside the app — your payment status, batch updates, certificates and support.";
    const appOk = await sendWhatsApp(profile.phone, appBody);
    if (appOk) {
      await log(db, studentId, "app_ready", "whatsapp", appBody, referenceId);
    }
    return { delivered: false, attempted: false, subscriptions: 0, reason: "whatsapp_only" };
  }

  if (type === "voice_call") {
    // Push + native FCM only. WhatsApp is registration-only now, so the old
    // WhatsApp parallel ring is gone; the native FCM path is the reliable one.
    const delivery = await sendPushFirst(db, studentId, type, message, referenceId, opts?.url ?? "/");
    if (referenceId) {
      await sendNativeCallPush(
        db,
        studentId,
        referenceId,
        opts?.nativeCall?.callerName ?? "Student Platform",
        opts?.nativeCall?.reason
      ).catch((e) => console.error("[lib/services/student-notifications] native call push failed:", e));
    }
    await log(db, studentId, type, "inbox", message, referenceId);
    return delivery;
  }

  // Default: Web Push first (best effort), then ALWAYS the in-app inbox.
  // The inbox row is the reliable record — it is what the student reads at
  // /notifications even when push never arrives on their device.
  const delivery = await sendPushFirst(db, studentId, type, message, referenceId, opts?.url ?? "/");
  await log(db, studentId, type, "inbox", message, referenceId);
  return delivery;
}

export function paymentStatusMessage(status: string, batchName?: string): string {
  switch (status) {
    case "approved":
      return `✅ <b>Payment Approved!</b>\n\nYour fee payment has been verified.${batchName ? ` You are now enrolled in <b>${batchName}</b>.` : ""}\n\n📱 Open your Student App to view your Certificate Collection Route Map, join your Batch Discussion, and see announcements.`;
    case "rejected":
      return `❌ <b>Payment Rejected</b>\n\nYour payment could not be verified. Please resubmit with a correct screenshot and UTR number. Open your Student App to try again.`;
    case "reupload_requested":
      return `📎 <b>Reupload Required</b>\n\nPlease reupload your payment screenshot. Open your Student App and go to Pay again.`;
    default:
      return `📋 Your payment status has been updated to: ${status}.`;
  }
}

export function batchAssignedMessage(batchName: string, registrationLink: string): string {
  return `🎓 <b>Batch Assigned!</b>\n\nYou have been enrolled in <b>${batchName}</b>.\n\nRegister now: ${registrationLink}`;
}

export function registrationCompleteMessage(
  fullName: string,
  batchName?: string,
  seats?: { registered: number; minSeats: number },
): string {
  const base = `✅ <b>Registration Complete!</b>\n\nHi ${fullName}, your registration has been received. ${batchName ? `You are in <b>${batchName}</b>. ` : ""}Your payment is now under review.\n\n💬 You can already join your Batch Discussion in the Student App to chat with your batch and admins — no need to wait for payment approval.`;
  if (!seats) return base;
  const { registered, minSeats } = seats;
  if (registered >= minSeats) {
    return base + `\n\n🎉 Your batch has reached the minimum of ${minSeats} students — the certificate petition can now begin.`;
  }
  const remaining = Math.max(0, minSeats - registered);
  return base +
    `\n\n🪑 You are student <b>#${registered}</b> in ${batchName ? `<b>${batchName}</b>` : "your batch"}.\n` +
    `The certificate petition can only start once we reach a minimum of <b>${minSeats}</b> students — ${remaining} more to go. Please share with your classmates so we can begin sooner.`;
}
