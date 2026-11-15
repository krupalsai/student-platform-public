-- Migration 0013: bot_started tracking on profiles
-- Applied to production via Supabase MCP.
--
-- Telegram bots cannot DM a user who has never pressed /start in a chat
-- with that bot — Telegram returns "bot was blocked by the user" or
-- silently drops the message. bot_started lets the approve flow know
-- whether an invite can be delivered immediately, or must be queued
-- (payments.invite_pending = true) until the student presses /start.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS bot_started BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bot_started_at TIMESTAMPTZ;
