-- Migration 0017: bank_sms_events table
-- Foundation for Bank SMS -> Webhook -> Match -> Admin Approve flow.
-- Deliberately NOT auto-approval: this table only stores and surfaces
-- bank-confirmed credit events for the admin to see alongside a payment's
-- UTR/screenshot before they tap Approve.

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

  -- Matching — set once an admin or the matching query links this event to a payment
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
