-- Migration 0012: invite_link tracking + payment idempotency
-- Applied to production via Supabase MCP. This file documents that change
-- so the migration history in the repo matches what's actually in the DB.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS invite_pending BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS invite_link TEXT,
  ADD COLUMN IF NOT EXISTS invite_link_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index — only enforced when a key is actually supplied,
-- so existing/null rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency_key
  ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
