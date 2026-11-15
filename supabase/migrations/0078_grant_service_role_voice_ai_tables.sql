-- 0076/0077 enabled RLS and granted EXECUTE on the voice-AI RPC functions to
-- service_role, but never granted the underlying TABLES themselves — the same
-- bug class as migrations 0050/0051/0069 (RLS is not a substitute for GRANTs).
--
-- Confirmed live: src/app/api/support/callback/route.ts,
-- bolna-webhook/route.ts, and cron/voice-ai/route.ts all call
-- db.from("ai_callback_requests"|"voice_ai_usage"|"voice_ai_accounts") directly
-- with the service-role client (not through the SECURITY DEFINER RPCs in
-- 0076), which fails with "permission denied for table" against every one of
-- these three tables as deployed. Applied directly to prod to unblock this
-- immediately; this file makes it reproducible for any future environment.
grant select, insert, update, delete on public.voice_ai_accounts to service_role;
grant select, insert, update, delete on public.voice_ai_usage to service_role;
grant select, insert, update, delete on public.ai_callback_requests to service_role;
