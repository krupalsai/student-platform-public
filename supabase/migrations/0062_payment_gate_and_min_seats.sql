-- Migration 0062: registration and payment become separate, server-controlled
-- states.
--
-- NOTE: this schema is ALREADY LIVE in production — applied directly via the
-- Supabase MCP during an earlier session on this same project. This file
-- exists so the migration history in the repo matches what is actually in the
-- database; running it again is a no-op (IF NOT EXISTS throughout).
--
-- Additive, and DEFAULTED TO TODAY'S BEHAVIOUR ON PURPOSE. `payment_open`
-- defaults to TRUE, so nothing changed for any existing batch the moment this
-- landed — a student mid-payment was never locked out by a deploy. The
-- automatic minimum-members gate (see src/lib/services/payment-gate.ts) is
-- what actually stops early payment, not this column; this column is only the
-- admin's manual veto on top of it.
--
-- min_seats is per batch and nullable. NULL means "use the platform default"
-- (PETITION_MIN_SEATS in lib/config.ts), so the threshold has one source of
-- truth rather than being copied into every row at creation time and
-- drifting from it.

ALTER TABLE batches ADD COLUMN IF NOT EXISTS payment_open boolean NOT NULL DEFAULT true;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS min_seats    integer;

COMMENT ON COLUMN batches.payment_open IS
  'Admin-controlled veto. False blocks every payment route for this batch, server-side. Cannot override the minimum-members gate — it can only close a batch that has already reached it. Defaults true so existing batches are unaffected.';
COMMENT ON COLUMN batches.min_seats IS
  'Per-batch registration threshold before payment opens and the petition can begin. NULL = the platform default (PETITION_MIN_SEATS).';
