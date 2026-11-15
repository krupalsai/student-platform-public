CREATE TABLE IF NOT EXISTS app_login_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  otp_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_login_otps_profile_idx ON app_login_otps(profile_id);
CREATE INDEX IF NOT EXISTS app_login_otps_hash_idx ON app_login_otps(otp_hash);

ALTER TABLE app_login_otps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_login_otps FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_login_otps TO service_role;
