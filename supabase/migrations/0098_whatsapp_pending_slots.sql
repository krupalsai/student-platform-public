-- Migration 0098: pending slot state for multi-step WhatsApp questions.
-- When the bot asks a follow-up ("which college?"), the answers already given
-- are kept here so the next reply completes the question instead of restarting
-- it. One row per phone, expires after 30 minutes (checked in code).
alter table public.whatsapp_moderation
  add column if not exists pending_intent text,
  add column if not exists pending_slots jsonb,
  add column if not exists pending_at timestamptz;
