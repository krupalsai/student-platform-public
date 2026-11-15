-- Migration 0091: student one-time login keys
--
-- Backs the WhatsApp "login link" flow: instead of sending login OTP codes
-- on WhatsApp, the bot mints a personal one-time link per student. Tapping
-- it signs them straight into the app — no code to type, no WhatsApp OTP.
--
-- Security properties (mirrors admin_login_otps):
--   - only the SHA-256 hash is stored; a DB leak exposes no usable links
--   - single use (used_at set atomically; the redeem query wins the race)
--   - 10-minute expiry
--   - bound to one profile_id; redeeming mints a session for that profile
--   - minted only server-side inside the WhatsApp webhook flow, never via a
--   - public endpoint (possession of the WhatsApp number is the identity proof)
--
-- Additive, no backfill needed.

CREATE TABLE IF NOT EXISTS student_login_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_student_login_keys_hash ON student_login_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_student_login_keys_profile ON student_login_keys(profile_id);
