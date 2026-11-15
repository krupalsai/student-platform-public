-- Migration 0032: explicit onboarding state column
--
-- Root cause of the infinite name-prompt loop:
--   The "waiting for name" state was inferred from preferred_name IS NULL,
--   but if migration 0031 hadn't run yet, the column is undefined on the
--   row object, so (undefined === null) is false — the name-collection
--   branch was never entered and every reply started the loop again.
--
-- Fix: explicit boolean flag. True = bot has asked for the name and is
-- waiting for the reply. False (default) = not in that state.
-- This makes the state machine unambiguous regardless of whether
-- preferred_name is null (never collected) or populated.
ALTER TABLE whatsapp_moderation
  ADD COLUMN IF NOT EXISTS waiting_for_name BOOLEAN NOT NULL DEFAULT false;

-- Back-fill: anyone who already has preferred_name set is past onboarding.
-- Anyone without it is NOT currently mid-prompt (safer to re-ask once than
-- to silently eat their first real message as a name).
UPDATE whatsapp_moderation
  SET waiting_for_name = false
  WHERE preferred_name IS NOT NULL;
