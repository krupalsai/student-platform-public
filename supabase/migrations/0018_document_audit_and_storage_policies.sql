-- Migration 0018: document audit_logs + storage.objects RLS policies
-- ─────────────────────────────────────────────────────────────────────────
-- IMPORTANT: These policies already exist live in production. This file
-- does NOT need to be re-run against the database — it exists solely to
-- close the gap between repo history and actual production state, found
-- during a 2026-06-22 audit. 0016_audit_logs.sql enabled RLS on audit_logs
-- but never created the matching policies; they were added directly via
-- Supabase at some point afterward, undocumented until now. Same situation
-- for storage.objects, which had no migration file at all.
--
-- If you are setting up a fresh environment from scratch, running this file
-- IS required (it is idempotent via DROP POLICY IF EXISTS + CREATE POLICY).

-- ── audit_logs ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS deny_anon ON audit_logs;
CREATE POLICY deny_anon ON audit_logs
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_authenticated ON audit_logs;
CREATE POLICY deny_authenticated ON audit_logs
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS service_role_full_access ON audit_logs;
CREATE POLICY service_role_full_access ON audit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── storage.objects ─────────────────────────────────────────────────────
-- Scoped per-bucket so service_role access to one bucket never implicitly
-- grants access to the other.

DROP POLICY IF EXISTS deny_anon_student_documents ON storage.objects;
CREATE POLICY deny_anon_student_documents ON storage.objects
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS deny_authenticated_student_documents ON storage.objects;
CREATE POLICY deny_authenticated_student_documents ON storage.objects
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS service_role_all_payment_screenshots ON storage.objects;
CREATE POLICY service_role_all_payment_screenshots ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'payment-screenshots')
  WITH CHECK (bucket_id = 'payment-screenshots');

DROP POLICY IF EXISTS service_role_all_student_documents ON storage.objects;
CREATE POLICY service_role_all_student_documents ON storage.objects
  FOR ALL TO service_role
  USING (bucket_id = 'student-documents')
  WITH CHECK (bucket_id = 'student-documents');
