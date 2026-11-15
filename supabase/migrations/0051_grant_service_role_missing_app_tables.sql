-- Migration 0051: restore service_role DML on app tables missing their grants.
--
-- Same class as 0050. These tables were created/recreated without the standard
-- service_role grants, so the app (service-role key) silently failed on them:
--   * whatsapp_processed_messages — the webhook's upsert(...).select("wamid")
--     needs SELECT; without it the idempotency claim errored and Meta retries
--     reprocessed messages (duplicate registration links / prompts / admin pings —
--     a silent regression of bug #28).
--   * student_notifications — log() INSERT and the student-delete cleanup DELETE
--     both silently failed (the notification audit table never populated).
--   * action_rate_limits — the student-delete cleanup DELETE silently failed,
--     which can leave FK-referencing rows behind and block the profile delete.
--   * whatsapp_contacts — included for consistency.
--
-- service_role is server-side only (never exposed to the browser), so full DML is
-- the intended state for these app tables — every other app table already has it.
-- Applied to production via Supabase MCP on 2026-08-05; idempotent.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_processed_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.student_notifications        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.action_rate_limits           TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_contacts            TO service_role;
