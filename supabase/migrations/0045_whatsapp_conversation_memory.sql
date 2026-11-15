-- Multi-turn conversation memory for the WhatsApp assistant.
--
-- Before this, the only "memory" was last_intent (a single string) and
-- last_message (a single string). The grounded-answer LLM call was passed an
-- EMPTY conversation history, so it had no idea what the student said one
-- message ago — every turn started cold. That is the main reason the bot felt
-- like a scripted decision tree rather than an assistant: it literally could
-- not follow a conversation.
--
-- recent_turns holds a short rolling transcript of the last few user/bot
-- messages for this person, as a compact JSON array:
--   [ { "r": "u" | "b", "t": "<text>", "at": "<iso timestamp>" }, ... ]
-- The application caps it (last ~10 turns) and only feeds turns from the
-- current ~30-minute session into the model, so prompt size and cost stay
-- bounded and a conversation from last week doesn't leak into today's.
--
-- Stored on whatsapp_moderation (one row per person already, keyed by the
-- 10-digit phone) so there is no extra join and it lives next to the rest of
-- that person's conversation state.

ALTER TABLE whatsapp_moderation
  ADD COLUMN IF NOT EXISTS recent_turns JSONB NOT NULL DEFAULT '[]'::jsonb;
