import type { SupabaseClient } from "@supabase/supabase-js";
import { sendWhatsAppText } from "@/lib/whatsapp/client";
import { normalizePhone } from "@/lib/services/students";
import { getActiveAdminPhones } from "@/lib/whatsapp/admin";
import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";

/**
 * Inbound WhatsApp call handling.
 *
 * Why this exists: students ring the WhatsApp number at any hour to ask how the
 * petition works. A call that arrives while nobody is awake previously left
 * NOTHING — no record, and the caller got silence and no answer.
 *
 * So a missed call now does two things: the caller gets an immediate reply with
 * the answer they were probably ringing for, and the admins get a notification
 * that survives until morning.
 *
 * Payload shape, verified against Meta's Calling API documentation:
 *   changes[].field === "calls"
 *   value.calls[] — each with id, from, to, event, timestamp, direction
 *   event "connect"   → incoming, carries an SDP offer we do not answer
 *   event "terminate" → carries status COMPLETED | REJECTED | FAILED,
 *                       plus start_time/end_time/duration when COMPLETED
 *
 * Only COMPLETED (or a real duration) counts as answered; REJECTED and FAILED
 * are misses. A few alternate spellings are still accepted because the rollout
 * moved field names, and the whole payload is stored in `raw` so the first
 * genuine call can confirm it. Nothing here throws on an unexpected shape.
 */

export interface ParsedCall {
  callId: string;
  from: string;
  /** Our business number, as Meta reports it. */
  to: string;
  /** Normalised to "inbound" (student rang us) or "outbound" (we rang them). */
  direction: "inbound" | "outbound";
  event: string;
  status: string;
  timestamp: string | null;
  durationSecs: number | null;
  answered: boolean;
  /** SDP offer, present on "connect" only. Needed to answer the call. */
  sdpOffer: string | null;
}

/**
 * Meta documents `direction` as "inbound"/"outbound", while some references use
 * USER_INITIATED/BUSINESS_INITIATED. Anything unrecognised is treated as
 * inbound: a student call wrongly skipped is the failure that matters, and an
 * outbound call is only ever placed by us, which we do not currently do.
 */
function normaliseDirection(raw: unknown): "inbound" | "outbound" {
  const d = String(raw ?? "").toUpperCase();
  if (d === "OUTBOUND" || d === "BUSINESS_INITIATED") return "outbound";
  return "inbound";
}

/** Pulls call objects out of a Meta webhook body. Returns [] for message-only payloads. */
export function parseCallEvents(body: any): { calls: ParsedCall[]; raw: any } {
  const out: ParsedCall[] = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "calls") continue;
      const list = change?.value?.calls ?? change?.value?.call ?? [];
      for (const c of Array.isArray(list) ? list : [list]) {
        if (!c) continue;

        // Meta's documented terminate statuses are COMPLETED, REJECTED and
        // FAILED. Only COMPLETED (or a real duration) means a human actually
        // spoke to them; REJECTED and FAILED are both misses.
        const status = String(c.status ?? c.call_status ?? "").toUpperCase();
        const event  = String(c.event  ?? c.type ?? "").toLowerCase();
        const dur    = Number(c.duration ?? c.duration_seconds ?? c.call_duration ?? 0);

        // Conservative on purpose: a wrongly-missed call costs one courtesy
        // message, a wrongly-answered one means the student is ignored again.
        const answered = dur > 0 || status === "COMPLETED";

        out.push({
          callId: String(c.id ?? c.call_id ?? ""),
          // `from` is the caller, `to` our business number. Meta sends `from`;
          // the alternates are kept only because the payload was unverifiable
          // when this was first written.
          from: String(c.from ?? c.from_number ?? ""),
          to: String(c.to ?? ""),
          // Meta sends "inbound"/"outbound"; some references use
          // USER_INITIATED/BUSINESS_INITIATED. Both are normalised here so the
          // caller-facing logic has one thing to test.
          direction: normaliseDirection(c.direction),
          event, status,
          timestamp: c.timestamp ? String(c.timestamp) : null,
          durationSecs: Number.isFinite(dur) ? dur : null,
          answered,
          // Meta puts the offer at value.calls[].session on the connect event.
          sdpOffer: c.session?.sdp_type === "offer" && c.session?.sdp
            ? String(c.session.sdp) : null,
        });
      }
    }
  }
  return { calls: out, raw: body };
}

/** The reply a missed caller gets. Answers the question they most likely rang about. */
function missedCallReply(name: string | null): string {
  return (
    `${name ? `Hi ${name}! ` : "Hi! "}Sorry we missed your call. 🙏\n\n` +
    `Here's how the petition process works:\n\n` +
    `1️⃣ *Register* — fill your details and upload your College ID\n` +
    `2️⃣ *Pay the fee* — you'll get the payment link after registering\n` +
    `3️⃣ *Get verified* — we check your payment and approve you\n` +
    `4️⃣ *Join your batch group* — you'll receive the Route Map with every step\n\n` +
    `Reply *REGISTER* to start, or just type your question here and I'll answer straight away.\n\n` +
    `_Messaging here is faster than calling — this chat is answered any time._`
  );
}

/**
 * Records a call and, when it was missed, replies to the caller and alerts admins.
 * Never throws — a webhook must always return 200 to Meta.
 */
export async function handleCallEvent(
  db: SupabaseClient,
  call: ParsedCall,
  raw: any,
): Promise<void> {
  try {
    if (!call.from) return;
    const phone = normalizePhone(call.from);

    // Meta re-delivers webhooks; the call id is the dedupe key. `event` is part
    // of the row so a connect and its later terminate are both kept.
    const rowId = call.callId ? `${call.callId}:${call.event || "x"}` : null;

    // Dedupe is enforced by the UNIQUE index on wa_call_id, not by a prior
    // SELECT. A check-then-insert leaves a window where two concurrent
    // deliveries of the same webhook both see "not found" and both send the
    // student a follow-up — and Meta retries aggressively, so that race is
    // reached in practice, not just in theory. The database is the only place
    // this can be decided atomically.
    const { data: inserted, error: insertErr } = await db.from("call_events").insert({
      wa_call_id: rowId,
      from_phone: phone,
      direction: call.direction,
      event: call.event,
      status: call.status,
      duration_secs: call.durationSecs,
      answered: call.answered,
      raw,
    }).select("id").single();

    if (insertErr) {
      // 23505 = unique violation: another delivery of this exact event won the
      // race and is already handling it. Anything else is a real failure.
      if (insertErr.code === "23505") {
        console.info(`[whatsapp/calls] duplicate webhook ignored for ${rowId}`);
        return;
      }
      console.error("[whatsapp/calls] call_events insert failed:", insertErr.message);
      return;
    }

    // Only act once the call is over, and only for calls the student made.
    if (call.event && call.event !== "terminate") return;
    if (call.direction === "outbound") return;
    if (call.answered) return;

    // ── Reply to the caller ────────────────────────────────────────────────
    const { data: profile } = await db
      .from("profiles").select("full_name").eq("phone", phone).maybeSingle();
    const { data: mod } = await db
      .from("whatsapp_moderation").select("preferred_name").eq("phone", phone).maybeSingle();
    const name = (profile?.full_name ?? mod?.preferred_name ?? null)?.split(" ")[0] ?? null;

    const ok = await sendWhatsAppText(phone, missedCallReply(name));

    // A call is not a message, so it may not open Meta's 24-hour window.
    // When the free-form send is refused, the caller hears nothing — there is
    // no paid-template fallback anymore (free-only rule, 2026-10-26). The
    // admin alert below is what makes sure they still get called back.

    if (inserted?.id) {
      await db.from("call_events")
        .update({ followed_up_at: new Date().toISOString(), follow_up_ok: ok })
        .eq("id", inserted.id);
    }

    // ── Tell the admins ────────────────────────────────────────────────────
    const when = new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short",
    });
    const text =
      `📞 *Missed call*\n\n` +
      `From: +91${phone}${name ? ` (${name})` : ""}\n` +
      `Time: ${when} IST\n\n` +
      (ok
        ? `✅ They've been sent the petition steps automatically.`
        : `⚠️ *They could not be messaged* — outside WhatsApp's 24-hour window (no paid template is used). Call them back.`);

    const phones = await getActiveAdminPhones(db);
    await Promise.allSettled(
      phones.map((p) => sendWhatsAppText(normalizeWhatsAppNumber(p), text)),
    );
  } catch (e) {
    // Swallowed on purpose: Meta retries non-200 responses, and a retry storm
    // would be worse than one lost log line.
    console.error("[whatsapp/calls] handleCallEvent failed:", e);
  }
}

/** Recent missed calls, for the admin CALLS command. */
export async function recentMissedCalls(db: SupabaseClient, limit = 10): Promise<string> {
  const { data } = await db
    .from("call_events")
    .select("from_phone, created_at, followed_up_at, follow_up_ok")
    .eq("answered", false)
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = data ?? [];
  if (!rows.length) return "📞 *Missed calls*\n\nNone — nobody has called and been missed.";

  const lines = rows.map((r: any) => {
    const when = new Date(r.created_at).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short",
    });
    const mark = r.follow_up_ok ? "✅" : r.followed_up_at ? "⚠️" : "•";
    return `${mark} +91${r.from_phone} — ${when}`;
  });

  return (
    `📞 *Missed calls* (latest ${rows.length})\n\n${lines.join("\n")}\n\n` +
    `✅ = they got the petition steps automatically\n` +
    `⚠️ = we could not message them — call them back`
  );
}

