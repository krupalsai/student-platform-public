-- push_subscriptions already existed in production before this migration —
-- created directly against the database by earlier work that was never
-- wired into any code path and never committed as a migration file. This
-- documents the schema as it actually is (confirmed against prod) so fresh
-- environments match; CREATE TABLE IF NOT EXISTS is a no-op where the table
-- is already present.
--
-- Used as a faster, zero-cost-first delivery path for login OTPs — see
-- requestAppLoginOtp in src/lib/app-login.ts — with WhatsApp remaining the
-- fallback for every student, not just ones without a subscription.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  failed_at timestamptz
);

CREATE INDEX IF NOT EXISTS push_subscriptions_student_idx ON push_subscriptions(student_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON push_subscriptions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO service_role;
