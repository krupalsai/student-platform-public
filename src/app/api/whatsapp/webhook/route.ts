import { NextRequest, NextResponse, after } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { parseIncomingWhatsApp } from "@/lib/whatsapp/parser";
import { handleIncomingWhatsAppMessage } from "@/lib/whatsapp/router";
import { bootstrapAdmins } from "@/lib/whatsapp/admin-service";
import { logSystemError } from "@/lib/system-errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { isAdminSender } from "@/lib/whatsapp/admin";

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "";
if (!APP_SECRET) {
  console.warn(
    "WHATSAPP_APP_SECRET not set — the WhatsApp webhook rejects ALL requests until it is set. " +
    "Set it immediately so Meta can deliver messages."
  );
}

/** Meta's one-time webhook verification handshake, run when the callback URL is configured in the Meta dashboard. */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

/** Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body,
 *  keyed with the app secret) so we only trust requests that actually came
 *  from Meta. Must run on the RAW body bytes — parsing to JSON first and
 *  re-stringifying would produce a different signature. */
function isValidMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!APP_SECRET) return false; // fail closed once configured to require it
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();

    // Fail closed: an unsigned request is rejected whether or not the
    // secret is configured. With the secret unset, skipping verification
    // would let anyone who finds this URL send fake messages, including
    // ones spoofing the admin's phone number.
    if (!APP_SECRET) {
      console.error("WhatsApp webhook: WHATSAPP_APP_SECRET is not set — unsigned request rejected");
      return NextResponse.json({ ok: false }, { status: 401 });
    }
    const signature = req.headers.get("x-hub-signature-256");
    if (!isValidMetaSignature(rawBody, signature)) {
      console.error("WhatsApp webhook: invalid or missing X-Hub-Signature-256 — request rejected");
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const body = JSON.parse(rawBody);

    // Call events arrive on the same webhook under field:"calls", not as
    // messages, so the message parser never sees them. Handled before
    // messages: a missed call at 3am used to leave no trace and give the
    // caller no answer.
    const { parseCallEvents, handleCallEvent } = await import("@/lib/whatsapp/calls");
    const { calls } = parseCallEvents(body);
    if (calls.length) {
      const dbc = createServiceClient();

      for (const c of calls) {
        // Record first, so the row exists and dedupe applies.
        await handleCallEvent(dbc, c, body);

      }
      return NextResponse.json({ ok: true });
    }

    const msg = parseIncomingWhatsApp(body);
    if (msg) {
      const db = createServiceClient();

      // ── Rate limit ───────────────────────────────────────────────────────
      // 30 messages/60s per sender. Admins exempt — a flood is a spam/bug
      // scenario for a student, never a reason to lock out the person who
      // needs to manage the bot. Silent 200 on block, same as duplicate
      // idempotency below: anything else makes Meta retry the flood.
      if (!isAdminSender(msg.from)) {
        const rl = await checkRateLimit(db, `wa-msg:${msg.from}`, 30, 60);
        if (!rl.allowed) {
          return NextResponse.json({ ok: true, note: "rate_limited" });
        }
      }

      // NOTE: the bot kill switch is enforced inside the router, NOT here —
      // it must silence the bot for STUDENTS while still letting admins through,
      // otherwise switching the bot off from WhatsApp would lock the admin out
      // of ever switching it back on.

      // ── Idempotency ──────────────────────────────────────────────────────
      // Meta retries a delivery whenever it doesn't get a fast 200 (its ack
      // window is only a few seconds, and this handler runs Groq + Gemini +
      // several DB/WhatsApp round-trips before replying). Re-processing one
      // physical message spawns duplicate registration links, duplicate
      // college prompts and duplicate admin pings. Claim the message id
      // atomically — ON CONFLICT DO NOTHING means a retry inserts nothing and
      // is dropped here, and it's race-safe under concurrent retries because
      // exactly one INSERT can win the primary key.
      if (msg.id) {
        const { data: claimed, error: claimErr } = await db
          .from("whatsapp_processed_messages")
          .upsert({ wamid: msg.id }, { onConflict: "wamid", ignoreDuplicates: true })
          .select("wamid");
        // Only skip on a definite duplicate (insert succeeded, returned no
        // row). If the claim query itself errored, fall through and process
        // rather than silently dropping a real message.
        if (!claimErr && (!claimed || claimed.length === 0)) {
          return NextResponse.json({ ok: true, note: "duplicate_ignored" });
        }
      }

      // Meta only needs the webhook acknowledgement quickly. Expensive
      // student processing (Supabase lookups, moderation, Gemini/Groq, and
      // WhatsApp sends) must not sit on the critical acknowledgement path.
      // Next.js after() schedules this work after the response is returned,
      // while the wamid claim above prevents Meta retries from processing the
      // same physical message twice.
      after(async () => {
        try {
          await bootstrapAdmins(db);
          // ── Missed-call leads (migration 0094) ─────────────────────
          // Before the student router: collect a lead chat ONLY from a
          // non-registered, non-admin number that has an open missed-call
          // lead. The module re-checks all of that itself and returns
          // false for everyone else, so registered students and admins
          // are never intercepted. See docs/missed-call-leads.md.
          if (msg.text) {
            const { handleMissedCallLeadMessage } = await import("@/lib/whatsapp/missed-call-leads");
            if (await handleMissedCallLeadMessage(db, msg.from, msg.text)) return;
          }
          await handleIncomingWhatsAppMessage(db, msg);
        } catch (e) {
          console.error("[whatsapp/webhook] deferred message processing failed:", e);
          await logSystemError(db, "api/whatsapp/webhook/deferred", e);
        }
      });
    }
    // Meta requires a fast 200 regardless — retries/backs off on non-2xx.
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("WhatsApp webhook error:", e);
    await logSystemError(createServiceClient(), "api/whatsapp/webhook", e);
    return NextResponse.json({ ok: true }); // still ack, per above
  }
}


