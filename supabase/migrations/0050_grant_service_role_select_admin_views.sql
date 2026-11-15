-- Migration 0050: restore service_role SELECT on the admin views.
--
-- INCIDENT (2026-08-05): the admin Payment Queue, payment-detail page, admin
-- stats/dashboard, and the WhatsApp PAYMENTS/PENDING commands all showed ZERO
-- data even though the payments existed. Root cause: admin_payment_queue,
-- admin_payment_detail and admin_stats had been recreated at some point without
-- re-granting SELECT to service_role (only TRUNCATE/REFERENCES/TRIGGER survived).
-- The app reads these views with the service-role key, so every read failed with
-- "permission denied for view ..." and the routes returned empty.
--
-- Fix: grant SELECT to service_role ONLY. These views expose every student's
-- payment data (full_name, phone, utr_number, ...), so they must NEVER be
-- readable by the public anon/authenticated PostgREST roles.
--
-- Applied to production via Supabase MCP on 2026-08-05; idempotent.

GRANT SELECT ON public.admin_payment_queue  TO service_role;
GRANT SELECT ON public.admin_payment_detail TO service_role;
GRANT SELECT ON public.admin_stats          TO service_role;

-- Defensive: make sure the public roles never gain SELECT on these admin views.
REVOKE SELECT ON public.admin_payment_queue  FROM anon, authenticated;
REVOKE SELECT ON public.admin_payment_detail FROM anon, authenticated;
REVOKE SELECT ON public.admin_stats          FROM anon, authenticated;
