-- registration_tokens: supports the WhatsApp -> website (not Telegram)
-- registration entry point. A student messages the WhatsApp bot, gets a
-- link straight to the real website (PhonePe does not support payments
-- initiated inside a Telegram in-app browser in India), registers and pays
-- there, then is linked to Telegram afterward purely for the dashboard/
-- Route Map — see telegram-link-token.ts / /api/auth/telegram-link.
--
-- NOTE: this file documents the schema as it actually exists live. It was
-- originally applied in two separate direct-to-Supabase steps (a simpler
-- version first, then extended with id/batch_id/profile_id/consumed_at to
-- match the registration-token.ts implementation) rather than as a single
-- migration file — recorded here now so a fresh database setup has it.
CREATE TABLE IF NOT EXISTS registration_tokens (
  token_hash text PRIMARY KEY,
  phone text NOT NULL,
  college text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  profile_id uuid REFERENCES profiles(id),
  consumed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS registration_tokens_id_key ON registration_tokens(id);
CREATE INDEX IF NOT EXISTS idx_registration_tokens_phone ON registration_tokens(phone);

ALTER TABLE registration_tokens ENABLE ROW LEVEL SECURITY;
-- No policies: only ever touched by the service-role client (WhatsApp
-- webhook issues tokens, /api/registration-tokens/validate + /register
-- redeem them). RLS enabled with zero policies means anon/authenticated
-- get zero access by default, matching the pattern used elsewhere in this
-- schema for service-role-only tables.

-- Needed so registration-token redemption can safely find-or-create a
-- profile by phone without risking duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_phone_unique ON profiles(phone) WHERE phone IS NOT NULL;
