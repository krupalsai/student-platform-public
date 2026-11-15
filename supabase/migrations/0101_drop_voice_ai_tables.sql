-- Drop the AI voice-agent tables and functions (voice agent removed 2026-11-06).
-- Tables voice_ai_accounts / voice_ai_usage / ai_callback_requests were used only
-- by the Vapi/Bolna phone agent (src/lib/voice-ai.ts, /api/voice-ai/*, /api/cron/voice-ai).
-- voice_calls (peer calling) and call_events (WhatsApp logging / missed calls) stay.
-- Safe to re-run: DROP ... IF EXISTS.

DROP FUNCTION IF EXISTS settle_voice_ai_usage(uuid, text, numeric, integer, text, text);
DROP FUNCTION IF EXISTS release_voice_ai_reservation(uuid, numeric);
DROP FUNCTION IF EXISTS register_voice_ai_call(uuid, text, numeric, text);
DROP FUNCTION IF EXISTS claim_voice_ai_account(numeric, uuid);
DROP FUNCTION IF EXISTS claim_voice_ai_account(numeric);

DROP TABLE IF EXISTS voice_ai_usage;
DROP TABLE IF EXISTS ai_callback_requests;
DROP TABLE IF EXISTS voice_ai_accounts;
