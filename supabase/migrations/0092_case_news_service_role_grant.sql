-- Migration 0092: 0084_case_news.sql was never applied to production and also
-- lacked the service_role grant (RLS policies are not a substitute for GRANTs).
-- /api/case-news returned HTTP 500 for every student until this was applied
-- (2026-10-06, applied via the Supabase MCP as "case_news_with_service_role_grant").
grant select, insert, update, delete on public.case_news to service_role;
