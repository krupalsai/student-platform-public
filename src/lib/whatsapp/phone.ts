/**
 * WhatsApp phone number utilities.
 *
 * Canonical E.164 formatter for OUTBOUND use — the Meta `to` field, admin
 * number comparison, and admin notify sends. Note: the whatsapp_moderation /
 * moderation-context tables are keyed by the 10-digit normalizePhone() form
 * (matching profiles.phone), NOT by this E.164 form — do not use this
 * function for those lookups, or state splits across two rows per person
 * (see migration 0043).
 *
 * Future additions belong here:
 *   normalizeIncomingPhone()   — if webhook format ever differs
 *   isSamePhone()              — safe equality across formats
 *   formatPhoneForDisplay()    — "+91 98XXX XXXXX" for UI
 */

/**
 * Normalise any Indian WhatsApp number into canonical E.164 format.
 *
 * Accepts all real-world variants seen in production:
 *   "98XXXXXXXX"      → "+91 98XXXXXXXX"  (10-digit local)
 *   "9198XXXXXXXX"    → "+91 98XXXXXXXX"  (12-digit, no +)
 *   "+9198XXXXXXXX"   → "+91 98XXXXXXXX"  (already correct)
 *   "+91 98XXXXXXXX"  → "+91 98XXXXXXXX"  (spaces)
 *   "098XXXXXXXX"     → "+91 98XXXXXXXX"  (leading 0)
 *
 * Used by:
 *   client.ts   — every outbound Meta API send
 *   admin.ts    — admin number comparison + all admin notify calls
 */
export function normalizeWhatsAppNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // 12 digits starting with 91 — already has country code, just add +
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  // 10-digit local number — prepend India country code
  if (digits.length === 10) return `+91${digits}`;
  // 11 digits with leading 0 (rare but observed)
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  // Anything else: best-effort — ensure it starts with +
  return raw.trim().startsWith("+") ? raw.trim() : `+${digits}`;
}

/**
 * Reduce any Indian mobile input to its 10-digit local form.
 *
 * Unlike the naive `.replace(/^91/, "")` pattern, the country code is only
 * stripped when the digit string actually HAS one (11–12 digits) — stripping
 * it unconditionally mangles a valid 10-digit number that merely starts with
 * 91, e.g. "9112345678" → "12345678" (8 digits), which then fails validation
 * and wrongly blocks the fee-page prefill.
 */
export function normalizeToLocalPhone(raw: string): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 11) && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/**
 * True only for a real Indian mobile number: exactly 10 digits starting
 * 6–9 after prefix normalization. This is the one validator every phone
 * write path (registration, profile correction, admin add/edit, copilot)
 * must agree on.
 */
export function isValidIndianMobile(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return /^[6-9]\d{9}$/.test(normalizeToLocalPhone(raw));
}

/**
 * Razorpay Checkout `prefill.contact` value (bare 10-digit local form), or
 * undefined when the stored phone is not a valid Indian mobile. The fee page
 * refuses to open checkout without it rather than show a blank number field.
 */
export function toPrefillContact(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const local = normalizeToLocalPhone(raw);
  return /^[6-9]\d{9}$/.test(local) ? local : undefined;
}
