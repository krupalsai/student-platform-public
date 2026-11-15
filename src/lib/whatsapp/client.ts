/**
 * WhatsApp send client — thin wrapper over the Meta Cloud API's /messages
 * endpoint. No business logic here at all; this only knows how to send
 * text, list, and button messages given already-decided content.
 */


import { normalizeWhatsAppNumber } from "@/lib/whatsapp/phone";
import { createServiceClient } from "@/lib/supabase/server";

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
const GRAPH_VERSION   = "v20.0";
const CONFIGURED_DISPLAY_NUMBER = (process.env.WHATSAPP_DISPLAY_NUMBER ?? "").replace(/\D/g, "");
// No hardcoded fallback number: the display number must come from Meta
// (preferred) or WHATSAPP_DISPLAY_NUMBER. If neither is available the
// callers get null and skip the wa.me link instead of linking a wrong number.

function isConfigured(): boolean {
  return !!(PHONE_NUMBER_ID && ACCESS_TOKEN);
}

let cachedDisplayNumber: string | null = null;

function validDisplayNumber(value: string): boolean {
  // wa.me requires the international number without + or punctuation.
  return /^\d{10,15}$/.test(value);
}

/**
 * The bot's own WhatsApp display number, fetched from Meta directly rather
 * than hardcoded — used to build click-to-chat (wa.me) links for the free
 * OTP flow (see app-login.ts). If Meta is unavailable or returns a malformed
 * value, use the explicitly configured display number (WHATSAPP_DISPLAY_NUMBER).
 * Returns null when no number is available, so callers skip the wa.me link
 * instead of ever generating an invalid one.
 */
export async function getWhatsAppDisplayNumber(): Promise<string | null> {
  if (cachedDisplayNumber) return cachedDisplayNumber;

  if (isConfigured()) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}?fields=display_phone_number`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
      );
      const body = await res.json().catch(() => null);
      const raw = body?.display_phone_number as string | undefined;
      const metaNumber = raw ? raw.replace(/\D/g, "") : "";
      if (validDisplayNumber(metaNumber)) {
        cachedDisplayNumber = metaNumber;
        return cachedDisplayNumber;
      }
      console.error("[wa] Meta returned an invalid display_phone_number", res.status);
    } catch (e) {
      console.error("[wa] display_phone_number fetch threw", (e as Error).message);
    }
  }

  if (/^\d{10,15}$/.test(CONFIGURED_DISPLAY_NUMBER)) {
    cachedDisplayNumber = CONFIGURED_DISPLAY_NUMBER;
    return cachedDisplayNumber;
  }

  // No usable display number: return null so callers skip the wa.me link
  // instead of linking a wrong number.
  return null;
}

const SERVICE_MONTHLY_LIMIT = Math.max(1, Number(process.env.WHATSAPP_SERVICE_MONTHLY_LIMIT ?? "1000"));

function usageMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Reserve one non-template WhatsApp send from the platform's monthly service
 * allowance. The Supabase RPC performs the increment atomically, so concurrent
 * Vercel requests cannot race past the cap. Template sends are tracked
 * separately and do not consume this service-message allowance.
 */
async function claimServiceMessageSlot(): Promise<boolean> {
  try {
    const db = createServiceClient();
    const { data, error } = await db.rpc("claim_whatsapp_free_slot", {
      p_month: usageMonth(),
      p_limit: SERVICE_MONTHLY_LIMIT,
    });
    if (error) {
      console.error("[wa] monthly service quota check failed", error.message);
      return false;
    }
    if (data == null) {
      console.warn("[wa] monthly service quota exhausted", {
        month: usageMonth(),
        limit: SERVICE_MONTHLY_LIMIT,
      });
      void sendQuotaAlert("exhausted");
      return false;
    }
    const used = Number(data);
    if (used >= SERVICE_MONTHLY_LIMIT) {
      void sendQuotaAlert("exhausted");
    } else if (used >= Math.ceil(SERVICE_MONTHLY_LIMIT * 0.9)) {
      void sendQuotaAlert("warning");
    }
    return true;
  } catch (e: any) {
    console.error("[wa] monthly service quota check threw", e?.message ?? String(e));
    return false;
  }
}

async function recordTemplateSend(): Promise<void> {
  try {
    const db = createServiceClient();
    const { error } = await db.rpc("bump_whatsapp_template_count", {
      p_month: usageMonth(),
    });
    if (error) console.error("[wa] template usage record failed", error.message);
  } catch (e: any) {
    console.error("[wa] template usage record threw", e?.message ?? String(e));
  }
}

async function sendQuotaAlert(kind: "warning" | "exhausted"): Promise<void> {
  try {
    const db = createServiceClient();
    const month = usageMonth();
    const { data: claimed, error: claimError } = await db.rpc("claim_whatsapp_quota_alert", {
      p_month: month,
      p_kind: kind,
    });
    if (claimError || !claimed) return;

    const { data: admins, error: adminError } = await db
      .from("admins")
      .select("phone")
      .ilike("role", "SUPER_ADMIN")
      .eq("active", true);
    if (adminError) throw adminError;

    const phones = [...new Set(
      (admins ?? [])
        .map((row: any) => String(row.phone ?? "").replace(/\\D/g, ""))
        .filter((phone: string) => /^\\d{10,15}$/.test(phone)),
    )];
    if (!phones.length) return;

    const text = kind === "warning"
      ? `⚠️ *WhatsApp service-message limit warning*

Your Student Platform has used about 90% of its monthly service-message allowance.

*Month:* ${month}
*Limit:* ${SERVICE_MONTHLY_LIMIT}

The remaining service-message capacity is limited. Template messages are tracked separately.`
      : `🚨 *WhatsApp service-message limit reached*

The Student Platform has reached its monthly service-message allowance.

*Month:* ${month}
*Limit:* ${SERVICE_MONTHLY_LIMIT}

New non-template WhatsApp messages are now blocked until the next month. Template sends remain separately tracked.`;

    await Promise.all(phones.map(async (phone) => {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: normalizeWhatsAppNumber(phone),
            type: "text",
            text: { body: text },
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        console.error("[wa] quota alert failed", {
          kind,
          status: res.status,
          error: body?.error?.message ?? null,
        });
      }
    }));
  } catch (e: any) {
    console.error("[wa] quota alert threw", e?.message ?? String(e));
  }
}

async function callGraphApi(payload: Record<string, unknown>): Promise<boolean> {
  if (!isConfigured()) {
    console.warn("[wa] not configured — WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN missing");
    return false;
  }
  const outboundType: string =
    (payload as any)?.interactive?.type ?? (payload as any)?.type ?? "unknown";
  const isTemplate = (payload as any)?.type === "template";
  if (!isTemplate && !(await claimServiceMessageSlot())) return false;
  // Log outbound shape — no access token, no message body content
  console.log("[wa] outbound", JSON.stringify({
    type: outboundType,
    to: (payload as any)?.to,
    interactive_action_name: (payload as any)?.interactive?.action?.name ?? null,
  }));
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
        body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
      }
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // Structured log — everything Meta returned, nothing sensitive from us
      console.error("[wa] FAILED", JSON.stringify({
        http_status:   res.status,
        outbound_type: outboundType,
        error_code:    body?.error?.code    ?? null,
        error_type:    body?.error?.type    ?? null,
        error_message: body?.error?.message ?? null,
        error_data:    body?.error?.error_data ?? null,
        fbtrace_id:    body?.error?.fbtrace_id ?? null,
      }));
    } else {
      if (isTemplate) await recordTemplateSend();
      console.log("[wa] ok", JSON.stringify({ type: outboundType }));
    }
    return res.ok;
  } catch (e: any) {
    console.error("[wa] network_error", e?.message ?? String(e));
    return false;
  }
}

/**
 * WhatsApp doesn't support HTML — it uses its own lightweight markdown
 * (*bold*, _italic_, ~strikethrough~, ```monospace```). Many message
 * builders in this codebase (student-notifications.ts, auto-approve.ts,
 * low-seat-alerts.ts, batch-full-flow.ts, faq.ts, and others) produce HTML
 * because that's what Telegram's parse_mode="HTML" expects, and the same
 * message strings get reused for WhatsApp sends too — which is why
 * students were seeing literal "<b>Registration Complete!</b>" text.
 *
 * Converting here, once, at the actual network boundary, means every
 * existing and future WhatsApp-bound message is safe automatically — no
 * need to hunt down and rewrite each message-builder individually, and no
 * risk of missing one later. Telegram sends are untouched by this; they
 * don't go through this file.
 */
/**
 * Real HTML tags the message builders can emit. The stray-tag sweep below is
 * limited to THESE names, because `<...>` is also how every usage string in the
 * admin help writes a placeholder — "MESSAGE <phone> <text>". A blanket
 * /<[^>]+>/ strip turned that into "MESSAGE " and admins were shown a usage
 * line with the arguments missing, which read as a broken command.
 */
const HTML_TAG_NAMES = "a|abbr|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|li|ol|p|pre|s|small|span|strike|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul";
const STRAY_HTML_TAG = new RegExp(`</?(?:${HTML_TAG_NAMES})(?:\\s[^<>]*)?/?>`, "gi");

export function htmlToWhatsAppText(input: string): string {
  return input
    .replace(/<(b|strong)>/gi, "*").replace(/<\/(b|strong)>/gi, "*")
    .replace(/<(i|em)>/gi, "_").replace(/<\/(i|em)>/gi, "_")
    .replace(/<(s|strike|del)>/gi, "~").replace(/<\/(s|strike|del)>/gi, "~")
    .replace(/<code>/gi, "```").replace(/<\/code>/gi, "```")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(STRAY_HTML_TAG, "") // strip any other stray tag defensively
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

export async function sendWhatsAppText(to: string, body: string, opts: { preserve?: string[] } = {}): Promise<boolean> {
  // Last-line defence: never let a credential-shaped string leave the server.
  const { redactCredentials, hasPlaceholder, hasFalsePromise, PLACEHOLDER_FALLBACK } = await import("@/lib/whatsapp/bot-guard");
  let safe = redactCredentials(htmlToWhatsAppText(body), opts.preserve ?? []);
  if (safe.redacted) console.warn("[whatsapp] redacted credential-shaped text from outbound message", { count: safe.redacted });
  // A reply with an unfilled placeholder ("[link]") was written without its
  // real value. Send a safe fallback instead of the broken text.
  if (hasPlaceholder(safe.text) || hasFalsePromise(safe.text)) {
    console.warn("[whatsapp] outbound text had an unfilled placeholder; sent fallback instead");
    safe = { text: PLACEHOLDER_FALLBACK, redacted: 0 };
  }
  return callGraphApi({ to: normalizeWhatsAppNumber(to), type: "text", text: { body: safe.text } });
}

/**
 * Sends an approved WhatsApp template.
 *
 * Meta only allows free-form text within 24 hours of the recipient's own last
 * message. Outside that window a plain send fails with error 131047 and the
 * person simply never hears from you — which is why a broadcast to everyone who
 * ever messaged the bot needs this path, not sendWhatsAppText.
 *
 * `bodyParams` fill the template's {{1}}, {{2}} … placeholders in order. The
 * template itself is created and approved in Meta Business Manager; nothing
 * here can invent one.
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[] = [],
): Promise<boolean> {
  if (!templateName) return false;
  return callGraphApi({
    to: normalizeWhatsAppNumber(to),
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode || "en" },
      ...(bodyParams.length
        ? { components: [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: t })) }] }
        : {}),
    },
  });
}

/**
 * Sends a photo. Meta fetches the URL itself, so nothing is uploaded from here
 * — a 3 MB route-map photo costs one small API call, not 3 MB of egress.
 *
 * The URL must be publicly reachable: Meta's servers fetch it, not the
 * student's phone, so a signed or IP-restricted URL fails with no useful error.
 * Cloudinary uploads in this project are public-delivery, which is why they
 * work here.
 */
export async function sendWhatsAppImage(
  to: string,
  imageUrl: string,
  caption?: string,
): Promise<boolean> {
  if (!imageUrl) return false;
  return callGraphApi({
    to: normalizeWhatsAppNumber(to),
    type: "image",
    image: {
      link: imageUrl,
      // Captions cap at 1024 characters; longer text is the caller's problem
      // to split, but truncating silently would lose it.
      ...(caption ? { caption: htmlToWhatsAppText(caption).slice(0, 1024) } : {}),
    },
  });
}

/** Sends a PDF/DOCX. `filename` is what the student sees when saving it. */
export async function sendWhatsAppDocument(
  to: string,
  documentUrl: string,
  filename?: string,
  caption?: string,
): Promise<boolean> {
  if (!documentUrl) return false;
  return callGraphApi({
    to: normalizeWhatsAppNumber(to),
    type: "document",
    document: {
      link: documentUrl,
      ...(filename ? { filename } : {}),
      ...(caption ? { caption: htmlToWhatsAppText(caption).slice(0, 1024) } : {}),
    },
  });
}

export interface WaMenuRow { id: string; title: string; description?: string }

export async function sendWhatsAppList(
  to: string,
  bodyText: string,
  buttonLabel: string,
  rows: WaMenuRow[]
): Promise<boolean> {
  return callGraphApi({
    to: normalizeWhatsAppNumber(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: htmlToWhatsAppText(bodyText) },
      action: { button: buttonLabel, sections: [{ title: "Options", rows }] },
    },
  });
}

export interface WaReplyButton { id: string; title: string }

export async function sendWhatsAppButtons(
  to: string,
  bodyText: string,
  buttons: WaReplyButton[]
): Promise<boolean> {
  return callGraphApi({
    to: normalizeWhatsAppNumber(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: htmlToWhatsAppText(bodyText) },
      action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
    },
  });
}

/**
 * Registration link message — tries CTA URL button first (requires verified
 * WABA), falls back to a clean formatted text message.
 *
 * The fallback is intentionally well-formatted — it does NOT look like an
 * error. Students on accounts that don't support cta_url still get a clear,
 * tappable link with proper context.
 */
export async function sendWhatsAppCtaButton(
  to: string,
  bodyText: string,
  buttonLabel: string,
  url: string,
  footerText?: string
): Promise<boolean> {
  // Meta rejects the whole message with "(#131009) Parameter value is not
  // valid ... display_text requires a length of at most, 20" — the button
  // silently never appears and the caller only finds out from the logs.
  // Production hit this five times. Truncating is strictly better than losing
  // the button, and the URL is unaffected.
  const label = buttonLabel.length > 20 ? `${buttonLabel.slice(0, 19)}…` : buttonLabel;
  if (label !== buttonLabel) {
    console.warn(`[wa] cta_url label truncated to 20 chars: "${buttonLabel}"`);
  }

  // Attempt 1: cta_url interactive button (verified WABA only)
  const ctaOk = await callGraphApi({
    to: normalizeWhatsAppNumber(to),
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: htmlToWhatsAppText(bodyText) },
      ...(footerText ? { footer: { text: htmlToWhatsAppText(footerText) } } : {}),
      action: {
        name: "cta_url",
        parameters: { display_text: label, url },
      },
    },
  });
  if (ctaOk) return true;

  // Attempt 2: Clean formatted text message — works on ALL accounts.
  // Designed to look intentional, not like an error fallback.
  // Plain text fallback — just the message and the link, nothing else.
  // The URL is caller-intended content (e.g. a registration link), so
  // preserve it verbatim — the credential guard would otherwise redact a
  // long-hex key inside it and send a broken link.
  return sendWhatsAppText(to, `${bodyText}\n\n${url}`, { preserve: [url] });
}
