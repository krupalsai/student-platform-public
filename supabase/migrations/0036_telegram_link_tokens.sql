-- telegram_link_tokens: attaches an existing website-created profile to a
-- Telegram identity after successful payment, without ever creating a
-- second profile row. See src/lib/telegram-link-token.ts.
--
-- NOTE: applied directly via Supabase during the v2 website-first migration
-- build with no corresponding migration file — recorded here now so a
-- fresh database setup has it.
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  profile_id uuid NOT NULL REFERENCES profiles(id),
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS telegram_link_tokens_profile_idx ON telegram_link_tokens(profile_id);
CREATE INDEX IF NOT EXISTS telegram_link_tokens_expires_idx ON telegram_link_tokens(expires_at);

ALTER TABLE telegram_link_tokens ENABLE ROW LEVEL SECURITY;
-- No policies: service-role client only (payment-completion flow issues
-- tokens, bot /start + Mini App initData route redeem them).

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS telegram_name text;
