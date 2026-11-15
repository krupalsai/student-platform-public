-- Student deletion was failing with a raw Postgres error surfaced straight
-- into the admin UI:
--   registration_tokens_profile_id_fkey
--
-- Root cause: five foreign keys pointing at profiles(id) were created with
-- no ON DELETE action, so Postgres defaults them to NO ACTION — every one
-- of them blocks DELETE FROM profiles. registration_tokens was merely the
-- first constraint Postgres happened to check; fixing only that one would
-- have surfaced telegram_link_tokens next, then action_rate_limits.
--
-- The other FKs into profiles were already correct (documents, petitions,
-- sessions, student_events, student_notifications CASCADE; audit_logs,
-- petitions.reviewed_by, removed_students.removed_by, student_queries
-- SET NULL). This migration only brings the five stragglers in line with
-- that existing, deliberate split:
--
--   * Ephemeral auth/throttling artifacts that exist ONLY to serve one
--     person are meaningless once that person is gone -> CASCADE.
--   * Business records that happen to record who authored them must
--     outlive their author, with authorship anonymised -> SET NULL.
--     (Same rule audit_logs.actor_id already uses.)
--
-- No constraint is dropped to "make the error go away" — every FK below is
-- recreated with an explicit, intentional delete rule, so referential
-- integrity is preserved in all cases.

-- ── Ephemeral, person-scoped: delete with the profile ──────────────────
-- A registration link exists only to register one specific person.
ALTER TABLE registration_tokens
  DROP CONSTRAINT IF EXISTS registration_tokens_profile_id_fkey;
ALTER TABLE registration_tokens
  ADD  CONSTRAINT registration_tokens_profile_id_fkey
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- A Telegram account-link token is single-use and profile-scoped
-- (profile_id is NOT NULL, so SET NULL is not even representable here).
ALTER TABLE telegram_link_tokens
  DROP CONSTRAINT IF EXISTS telegram_link_tokens_profile_id_fkey;
ALTER TABLE telegram_link_tokens
  ADD  CONSTRAINT telegram_link_tokens_profile_id_fkey
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- Rate-limit counters are short-lived throttling state, not a record of
-- anything. actor_id is NOT NULL, so CASCADE is the only correct option.
ALTER TABLE action_rate_limits
  DROP CONSTRAINT IF EXISTS action_rate_limits_actor_id_fkey;
ALTER TABLE action_rate_limits
  ADD  CONSTRAINT action_rate_limits_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES profiles(id) ON DELETE CASCADE;

-- ── Business records: outlive their author, authorship anonymised ──────
-- An announcement students have already seen must not vanish because the
-- admin who wrote it was later removed.
ALTER TABLE announcements
  DROP CONSTRAINT IF EXISTS announcements_created_by_fkey;
ALTER TABLE announcements
  ADD  CONSTRAINT announcements_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;

-- Admin invite history is an access-control audit trail — keep the row,
-- drop only the link to the deleted author.
ALTER TABLE admin_invites
  DROP CONSTRAINT IF EXISTS admin_invites_created_by_fkey;
ALTER TABLE admin_invites
  ADD  CONSTRAINT admin_invites_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
