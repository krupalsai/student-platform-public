/**
 * Safety layer for the student/admin WhatsApp bot. Rules live in code, not in
 * the model, so a clever message cannot switch them off.
 *
 *  1. Input guard  — blocks requests for secrets, database/SQL actions and
 *                    attempts to override the bot's instructions, before any
 *                    FAQ search or AI call runs.
 *  2. Output guard — redacts anything that looks like a credential before a
 *                    message leaves the server, as a last line of defence.
 *
 * Deliberately conservative: a false block returns a polite fixed reply and is
 * logged, which is cheaper than leaking a key.
 */

export type BlockCategory = "secret_request" | "database_action" | "prompt_injection";

const SECRET_REQUEST = /\b(api[\s_-]*keys?|secret[s]?|tokens?|passwords?|passcodes?|env(?:ironment)?\s*(?:vars?|variables?)?|\.env|service[\s_-]*role|private[\s_-]*key|webhook[\s_-]*secret|access[\s_-]*token|credentials?)\b/i;
const SECRET_VERB = /\b(show|give|send|share|reveal|tell|print|display|what\s+(?:is|are)|paste|list|dump|copy|provide)\b/i;

const DATABASE_ACTION = /\b(drop\s+(?:table|database|schema)|truncate\s+table|delete\s+(?:all|every|the\s+whole)?\s*(?:database|db|table|students?|records?|data|payments?)|wipe\s+(?:the\s+)?(?:database|db|data)|select\s+\*\s+from|insert\s+into|update\s+\w+\s+set|alter\s+table|grant\s+all|rm\s+-rf|sudo\s+|psql\b|supabase\s+db)\b/i;

const INJECTION = /\b(ignore\s+(?:all\s+|your\s+|the\s+|previous\s+|prior\s+)*(?:instructions?|rules?|prompts?)|disregard\s+(?:your|the|all)\s+(?:rules|instructions)|system\s*prompt|reveal\s+your\s+(?:prompt|instructions)|you\s+are\s+now\s+(?:in\s+)?(?:admin|developer|dan|god)\s*mode|act\s+as\s+(?:an?\s+)?admin|jailbreak|developer\s+mode|bypass\s+(?:the\s+)?(?:rules|filter|safety))\b/i;

export function checkInboundRequest(text: string): BlockCategory | null {
  const t = text.trim();
  if (!t) return null;
  if (INJECTION.test(t)) return "prompt_injection";
  if (DATABASE_ACTION.test(t)) return "database_action";
  if (SECRET_REQUEST.test(t) && SECRET_VERB.test(t)) return "secret_request";
  return null;
}

export const BLOCKED_REPLY: Record<BlockCategory, string> = {
  secret_request: "I can't share passwords, keys or system settings. If you need account help, reply *Menu* or contact Student Support.",
  database_action: "I can't run database or delete actions from WhatsApp. Reply *Menu* for what I can help with.",
  prompt_injection: "I can only help with student services. Reply *Menu* to see what I can do.",
};

/** Patterns for credential-shaped strings. Matches are replaced, never echoed. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,                 // OpenAI/OpenRouter-style keys
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g,
  /\bgsk_[A-Za-z0-9]{16,}\b/g,                  // Groq
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,                // Google
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,          // GitHub fine-grained
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\brzp_(?:live|test)_[A-Za-z0-9]{10,}\b/g,    // Razorpay
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs (Supabase service role)
  /\bsbp_[A-Za-z0-9]{20,}\b/g,                  // Supabase personal tokens
  /\b[A-Fa-f0-9]{32,}\b/g,                      // long hex secrets (HMAC/app secrets)
];

export function redactCredentials(text: string, preserve: string[] = []): { text: string; redacted: number } {
  // Exact substrings the caller is intentionally sending (e.g. a login
  // code, or a registration link) must survive: mask them with
  // placeholders that match no credential pattern, redact everything
  // else, then restore. Without this, the guard ate the old 64-hex
  // sign-in link itself — a 64-hex key matches the "long hex secret"
  // pattern below, so VERIFY replies arrived with ?key=[redacted] and
  // /login showed "Validation failed" (the 9-char "[redacted]" fails
  // the key's 16-char minimum). That link flow is gone (9 Nov 2026);
  // a 6-digit code matches no pattern at all, but it is still passed
  // as preserve so a future pattern can never eat it. Preserve is
  // opt-in per call site and only ever holds the exact value that
  // caller minted.
  const saved: string[] = [];
  let out = text;
  for (const p of preserve) {
    if (!p) continue;
    const token = `\u0000PRESERVE${saved.length}\u0000`;
    if (out.includes(p)) { saved.push(p); out = out.split(p).join(token); }
  }
  let redacted = 0;
  for (const re of CREDENTIAL_PATTERNS) {
    out = out.replace(re, () => { redacted++; return "[redacted]"; });
  }
  for (let i = 0; i < saved.length; i++) {
    out = out.split(`\u0000PRESERVE${i}\u0000`).join(saved[i]);
  }
  return { text: out, redacted };
}

/**
 * Unfilled template placeholders such as "[link]", "{name}", "<college>" or
 * "[amount]". A generated reply that still contains one was written without
 * its real value, so it must never reach a student.
 */
const PLACEHOLDER_RE = /\[(?:link|name|college|batch|amount|fee|date|url|phone|roll|student|tbd|insert[^\]]*)\]|\{\{?\s*[a-z_]+\s*\}\}?|<(?:link|name|college|batch|amount|url)>/i;

export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER_RE.test(text);
}

export const PLACEHOLDER_FALLBACK =
  "I don't know this one yet. I've passed your question to the admin and they'll reply here. In the meantime, reply *Menu* for registration, payment, or batch status.";

/**
 * Replies that promise an action the bot cannot perform in this message
 * ("I'll check your records", "I'll send you the link", "let me look that up").
 * Only real flows send links, check records or look things up, so a text-only
 * promise is replaced with a deterministic fallback.
 */
const FALSE_PROMISE_RE = /\b(?:i(?:'ll| will)\s+(?:check|look(?:\s+up)?|send|find|verify|search|review|get back|look into)|let\s+me\s+(?:check|look|find|verify|search)|i'?m\s+checking|checking\s+your\s+records)\b/i;

export function hasFalsePromise(text: string): boolean {
  return FALSE_PROMISE_RE.test(text);
}

