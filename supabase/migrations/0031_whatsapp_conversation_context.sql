-- Migration 0031: WhatsApp conversation context columns
--
-- preferred_name : student's name captured on first contact (ask_name flow)
-- last_intent    : last classified intent — enables follow-up resolution
--                  e.g. "How much?" after "Registration" → fee context
-- last_intent_at : when that intent was set — stale context (>10 min) is
--                  not used so accidental follow-up misclassification
--                  doesn't persist across separate conversations
ALTER TABLE whatsapp_moderation
  ADD COLUMN IF NOT EXISTS preferred_name  TEXT,
  ADD COLUMN IF NOT EXISTS last_intent     TEXT,
  ADD COLUMN IF NOT EXISTS last_intent_at  TIMESTAMPTZ;
