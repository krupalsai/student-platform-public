-- OTPs for the "confirm it's you" step between /install and /register.
-- Keyed by registration_tokens.id rather than a profile, since a brand
-- new registrant has no profile row yet at this point in the flow.
CREATE TABLE IF NOT EXISTS registration_token_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_token_id uuid NOT NULL REFERENCES registration_tokens(id) ON DELETE CASCADE,
  otp_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_token_otps_token_idx ON registration_token_otps(registration_token_id);
CREATE INDEX IF NOT EXISTS registration_token_otps_hash_idx ON registration_token_otps(otp_hash);

ALTER TABLE registration_token_otps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON registration_token_otps FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON registration_token_otps TO service_role;
