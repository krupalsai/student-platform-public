-- Migration 0069: recreate bank_sms_events
--
-- This table existed once (migration 0017, applied 2026-06-22) and was
-- deliberately DROPPED on 2026-07-03 ("PhonePe PG is now the sole payment
-- verification path", 0 rows ever existed) along with all the application
-- code that used it (webhook route, parser lib, admin detail enrichment).
--
-- Recreated now per an explicit request to add automatic verification for
-- MANUAL UPI payments specifically (PhonePe/Razorpay gateway payments are
-- already verified in real time by their own webhooks and don't need this).
-- Same design as the original: this table only stores and surfaces
-- bank-confirmed credit events for the admin to see alongside a payment's
-- UTR/screenshot before they tap Approve. It never auto-approves anything
-- including the period where a later, since-reverted version of this same
-- feature briefly did auto-approve before being removed entirely.
--
-- Definition is identical to the original 0017 migration, plus the
-- service_role GRANT that 0017 itself was missing (RLS policies are not a
-- substitute for table GRANTs — the same bug affected admin_payment_queue
-- and other tables; this table had the identical gap and would have failed
-- silently on every webhook call).

CREATE TABLE IF NOT EXISTS bank_sms_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Raw inbound data — always stored, even if parsing fails
  raw_sms         TEXT NOT NULL,
  sender          TEXT,                  -- SMS sender ID as reported by the forwarder app
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when our webhook received it

  -- Parsed fields — NULL until a bank-specific parser successfully extracts them
  bank            TEXT,                  -- 'sbi' | 'kotak' | null if unparsed
  amount          NUMERIC,
  utr_ref         TEXT,                  -- bank's own reference number, if present in the SMS
  credited_at     TIMESTAMPTZ,           -- transaction time as stated in the SMS, if parseable
  parsed          BOOLEAN NOT NULL DEFAULT false,
  parse_error     TEXT,                  -- human-readable reason parsing failed, for review

  -- Duplicate protection — hash of (sender + raw_sms), forwarder apps retry on failure
  dedupe_hash     TEXT NOT NULL,

  -- Matching — set once the matching query links this event to a payment
  matched_payment_id UUID REFERENCES payments(id),
  matched_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_sms_dedupe
  ON bank_sms_events (dedupe_hash);

CREATE INDEX IF NOT EXISTS idx_bank_sms_unparsed
  ON bank_sms_events (parsed)
  WHERE parsed = false;

CREATE INDEX IF NOT EXISTS idx_bank_sms_amount_time
  ON bank_sms_events (amount, credited_at)
  WHERE parsed = true;

CREATE INDEX IF NOT EXISTS idx_bank_sms_matched_payment
  ON bank_sms_events (matched_payment_id);

ALTER TABLE bank_sms_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_bank_sms_events ON bank_sms_events;
CREATE POLICY service_role_all_bank_sms_events ON bank_sms_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- The actual fix over the original 0017: 0017 relied on the RLS policy
-- above alone and never granted the table itself, so every insert/select
-- from the app's service-role key would have failed with "permission
-- denied" even with a correct policy in place.
GRANT SELECT, INSERT, UPDATE ON bank_sms_events TO service_role;
