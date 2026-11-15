-- Supports the WhatsApp "LOGIN" admin command: the admin panel session
-- lives in whatever browser/WebView last authenticated (Telegram WebView's
-- localStorage is separate from Chrome's), so an admin opening the panel
-- in Chrome has no session and just sees the marketing page. LOGIN
-- generates a one-time link admins can open in Chrome to get a real
-- session there.
--
-- Same shape as other one-time-use tokens in this project (registration_tokens,
-- telegram_link_tokens): store a HASH of the raw token, never the token
-- itself, short expiry, single-use enforced by checking used_at IS NULL.
--
-- NOT yet applied live — the Supabase connector disconnected mid-session
-- before this could be run. Apply this manually (Supabase SQL editor or
-- reconnect the connector) before the LOGIN command will actually work.
CREATE TABLE IF NOT EXISTS admin_login_otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  otp_hash    text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_login_otps_hash_idx ON admin_login_otps(otp_hash);
CREATE INDEX IF NOT EXISTS admin_login_otps_profile_idx ON admin_login_otps(profile_id);

ALTER TABLE admin_login_otps ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_login_otps_service_role ON admin_login_otps
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Learned the hard way twice already on this project (admins table, then a
-- batch of other app tables in 0051): an RLS policy is not a substitute for
-- a table-level GRANT. Both are required or every service_role query here
-- fails with "permission denied for table admin_login_otps".
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_login_otps TO service_role;
