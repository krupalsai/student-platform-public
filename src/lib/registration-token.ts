import { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes, randomInt, createHash } from "crypto";
import { getCurrentActiveBatch } from "@/lib/services/batches";
import { normalizePhone } from "@/lib/services/students";

/**
 * Website Registration Tokens.
 *
 * Requirements (from the website-first migration plan):
 *   - Signed:            we only ever store/compare a SHA-256 hash, never
 *                         the raw token (same pattern as sessions.token_hash).
 *   - Opaque:             raw token is 32 random bytes, hex-encoded — carries
 *                         no decodable information about the student.
 *   - Server validated:  validateRegistrationToken() is the only way to
 *                         resolve a token; there is no client-side check.
 *   - Linked to phone:    every token is issued against a phone number, not
 *                         a Telegram identity.
 *   - Expire automatically: `expires_at`, checked on every validation.
 *   - Invalid after successful payment: `consumed_at` is set by the payment
 *                         completion flow (step 5), checked on validation.
 *   - Reusable while payment is incomplete: validation only rejects on
 *                         expiry or consumption — not on "already used to
 *                         view the registration form."
 */

const TOKEN_TTL_HOURS = Number(process.env.REGISTRATION_TOKEN_TTL_HOURS ?? 72);

export interface RegistrationTokenPayload {
  id: string;
  phone: string;
  college: string;
  batchId: string;
  profileId: string | null;
}

/**
 * Issues a new registration token for a phone number + college's current
 * active batch. Returns null if there's no active batch for that college
 * (the caller — e.g. the WhatsApp flow — should show the waiting-queue
 * message in that case, per step 6 of the migration plan).
 */
export async function issueRegistrationToken(
  db: SupabaseClient,
  phone: string,
  college: string
): Promise<{ raw: string; shortCode: string; expiresAt: string } | null> {
  const batch = await getCurrentActiveBatch(db, college);
  if (!batch) return null;

  // Reuse an existing, still-valid token for this exact phone + college +
  // active batch instead of minting a brand-new link every time. Tokens are
  // explicitly reusable while payment is incomplete (see
  // validateRegistrationToken), so issuing a fresh one on every re-tap of
  // Register / re-selection of college just sends the student several
  // different links for the same thing and accumulates rows in
  // registration_tokens. Scoped to batch.id so a token for a since-replaced
  // batch is never handed back.
  const { data: reusable } = await db.from("registration_tokens")
    .select("short_code, expires_at")
    .eq("phone", normalizePhone(phone))
    .eq("college", college)
    .eq("batch_id", batch.id)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .not("short_code", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (reusable?.short_code) {
    // raw is intentionally empty — buildRegistrationLink uses short_code when
    // present, and the raw 64-char token is never needed once one exists.
    return { raw: "", shortCode: reusable.short_code, expiresAt: reusable.expires_at };
  }

  const raw = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3600_000).toISOString();

  // 12-char base64url from 9 random bytes — no modulo bias, URL-safe,
  // short enough to keep the WhatsApp message clean, long enough
  // (~2^72 possible values) that brute-forcing isn't remotely practical
  // even before the rate limit on /r/[code] and the token's own 72h
  // expiry are factored in. Retries on the rare unique-index collision
  // rather than trusting a single attempt never collides.
  let shortCode = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomBytes(9).toString("base64url");
    const { data: existing } = await db.from("registration_tokens")
      .select("id").eq("short_code", candidate).maybeSingle();
    if (!existing) { shortCode = candidate; break; }
  }
  if (!shortCode) throw new Error("Could not generate a unique short code after 5 attempts");

  const { error } = await db.from("registration_tokens").insert({
    token_hash: tokenHash,
    short_code: shortCode,
    phone: normalizePhone(phone),
    college,
    batch_id: batch.id,
    expires_at: expiresAt,
  });
  if (error) throw error;

  return { raw, shortCode, expiresAt };
}

/**
 * The one canonical place a registration link is built anywhere in this
 * codebase. Every caller that used to hand-construct
 * `${appUrl}/register?token=${raw}` should call this instead.
 *
 * Returns the short link — `/r/<shortCode>` redirects straight to
 * `/register?token=<shortCode>` (see app/r/[code]/route.ts), so the
 * student lands on registration in whatever browser opened the link.
 * No install step: the app works in the browser, and install is
 * optional (the browser itself offers it).
 * validateRegistrationToken() below recognizes short codes directly, so
 * the raw 64-char token is never needed again once a short code exists.
 * Falls back to the long-token install URL only if short-code generation
 * somehow failed (defensive — issueRegistrationToken always returns one
 * today).
 */
export function buildRegistrationLink(issued: { raw: string; shortCode: string }): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://studentplatform.dev";
  return issued.shortCode ? `${appUrl}/r/${issued.shortCode}` : `${appUrl}/install?token=${issued.raw}`;
}

/**
 * Validates a raw 64-char token OR a 12-char short code — must exist, be
 * unexpired, and not yet consumed. Returns the token's linked identity
 * (phone/college/batch/profile) or null if invalid for any reason —
 * callers should treat all failure reasons the same to the client ("this
 * link is no longer valid") rather than distinguishing expired vs.
 * consumed vs. not-found, which would leak information about token
 * existence.
 *
 * Legacy 64-char hex tokens (issued before short codes existed, or from
 * any link a student saved/bookmarked from before this change) continue
 * working unmodified — this is purely additive.
 */
export async function validateRegistrationToken(
  db: SupabaseClient,
  tokenOrCode: string
): Promise<RegistrationTokenPayload | null> {
  const isLegacyRawToken = /^[0-9a-f]{64}$/.test(tokenOrCode);

  const { data } = isLegacyRawToken
    ? await db.from("registration_tokens")
        .select("id, phone, college, batch_id, profile_id, expires_at, consumed_at")
        .eq("token_hash", createHash("sha256").update(tokenOrCode).digest("hex"))
        .maybeSingle()
    : await db.from("registration_tokens")
        .select("id, phone, college, batch_id, profile_id, expires_at, consumed_at")
        .eq("short_code", tokenOrCode)
        .maybeSingle();

  if (!data) return null;
  if (data.consumed_at) return null;
  if (new Date(data.expires_at) <= new Date()) return null;

  return { id: data.id, phone: data.phone, college: data.college, batchId: data.batch_id, profileId: data.profile_id };
}

/**
 * Links a token to the profile it's being used to register/complete, so
 * later steps (payment completion) know which profile to mark consumed
 * against without re-deriving it from phone lookup.
 */
export async function attachProfileToToken(db: SupabaseClient, tokenId: string, profileId: string): Promise<void> {
  await db.from("registration_tokens").update({ profile_id: profileId }).eq("id", tokenId);
}

/**
 * Marks a token permanently invalid after successful payment. Called from
 * the payment-completion flow (step 5) — never from the registration form
 * itself, since the token must stay reusable while payment is pending.
 */
export async function consumeRegistrationToken(db: SupabaseClient, tokenId: string): Promise<void> {
  await db.from("registration_tokens").update({ consumed_at: new Date().toISOString() }).eq("id", tokenId);
}

/**
 * The newest still-usable registration token issued to this phone, if any.
 * Used by the WhatsApp "VERIFY" reply to tell a person who is mid-registration
 * (they need a registration code) from one who is just logging in.
 */
export async function findPendingRegistrationTokenForPhone(
  db: SupabaseClient,
  phone: string
): Promise<{ id: string } | null> {
  const { data } = await db
    .from("registration_tokens")
    .select("id")
    .eq("phone", normalizePhone(phone))
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id as string } : null;
}

const REGISTRATION_OTP_TTL_MS = 5 * 60 * 1000;

export function hashRegistrationOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

/**
 * Creates the 6-digit "confirm it's you" code for a registration link and
 * returns it, to be delivered exactly once. Shared by
 * /api/registration-tokens/request-otp and the WhatsApp "VERIFY" reply so the
 * code's shape, lifetime and hashing live in one place. The matching check is
 * /api/registration-tokens/verify-otp. `code` lets the VERIFY reply store the
 * SAME value as the login code, so one WhatsApp message works on either screen.
 */
export async function issueRegistrationOtp(db: SupabaseClient, tokenId: string, code?: string): Promise<string> {
  const otp = code ?? String(randomInt(100000, 1000000));
  const { error } = await db.from("registration_token_otps").insert({
    registration_token_id: tokenId,
    otp_hash: hashRegistrationOtp(otp),
    expires_at: new Date(Date.now() + REGISTRATION_OTP_TTL_MS).toISOString(),
  });
  if (error) throw error;
  return otp;
}
