-- Adds a super_admin tier above the existing admin/viewer roles on
-- profiles.role (plain text, no CHECK constraint — see 0001_initial_schema).
--
-- Every account that has role='admin' today gets full access to
-- everything it already had (Settings, Health, Route Map, Activity Logs,
-- Users) — nothing changes for them. Going forward, a NEW admin added via
-- /admin/users or the "ADD ADMIN" flow defaults to plain 'admin', which is
-- now a restricted tier: it can still do payments/students/batches/
-- announcements/broadcast/questions/analytics/export/copilot, but NOT
-- Settings, Health, Route Map, Activity Logs, or Users (the last one is a
-- deliberate addition beyond the original request — a restricted admin
-- must not be able to reach /admin/users and promote themselves to
-- super_admin, or the whole restriction is pointless).
--
-- This only touches the WEBSITE role system (profiles.role). The
-- completely separate WhatsApp admin system (its own `admins` table,
-- SUPER_ADMIN/ADMIN/VIEWER roles) is untouched by this migration.
UPDATE profiles SET role = 'super_admin' WHERE role = 'admin';

-- pending_admins (0005_pending_admins.sql) has a CHECK constraint limiting
-- role to admin/viewer — widen it so a super_admin can pre-designate a
-- not-yet-logged-in Telegram ID as a future super_admin too (the "Add Admin
-- or Viewer by Telegram ID" flow, /api/admin/users/add-admin).
ALTER TABLE pending_admins DROP CONSTRAINT IF EXISTS pending_admins_role_check;
ALTER TABLE pending_admins ADD CONSTRAINT pending_admins_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'viewer'::text, 'super_admin'::text]));
