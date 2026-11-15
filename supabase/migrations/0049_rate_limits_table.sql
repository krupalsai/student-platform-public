-- Migration 0049: rate_limits table (sliding-window API rate limiter)
--
-- IMPORTANT — schema-drift repair. The `rate_limits` table has existed in the
-- production database and is used by src/lib/rate-limit.ts (checkRateLimit) for
-- PhonePe payment-initiation, Telegram-message, and WhatsApp-message rate
-- limiting. It was created out-of-band and never had a migration, so a fresh
-- environment rebuilt purely from these migration files would be MISSING this
-- table — every checkRateLimit() call would then error and, by design, fail
-- OPEN (returns allowed:true), silently disabling all rate limiting.
--
-- This migration reproduces the exact live schema (verified via
-- information_schema against the production project). It is fully
-- idempotent: on the existing production DB every statement is a no-op.

CREATE TABLE IF NOT EXISTS rate_limits (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_bucket_time
  ON rate_limits (bucket_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rate_limits_created_at
  ON rate_limits (created_at);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_rate_limits_tbl ON rate_limits;
CREATE POLICY service_role_all_rate_limits_tbl ON rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);
