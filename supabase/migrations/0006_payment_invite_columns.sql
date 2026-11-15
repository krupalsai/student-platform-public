-- Migration 0006: Payment invite tracking + batch telegram_invite_link
-- Applied directly to Supabase on deployment
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS invite_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invite_failed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS telegram_invite_link TEXT;
