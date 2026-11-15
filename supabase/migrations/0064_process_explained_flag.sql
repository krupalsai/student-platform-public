-- Migration 0064: remember who has already had the full petition process
-- explained to them on WhatsApp.
--
-- NOTE: already live in production (applied directly via Supabase MCP in an
-- earlier session); this file records it in the repo. Re-running is a no-op.
--
-- Lives on whatsapp_moderation (keyed by 10-digit phone), not on profiles:
-- most people who message the bot have no profile yet — the phone number is
-- the only identity available at "hi".

ALTER TABLE whatsapp_moderation
  ADD COLUMN IF NOT EXISTS process_explained_at timestamptz;

COMMENT ON COLUMN whatsapp_moderation.process_explained_at IS
  'When the full petition-process explanation was sent to this number. NULL = never sent; sent once, right after we learn their name.';
