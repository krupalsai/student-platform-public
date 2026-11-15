-- Closes a check-then-insert race window in POST /api/payments/upi-submit.
-- The existing duplicate-submission check (SELECT for an existing
-- submitted/approved payment before INSERT) is not atomic, so two
-- near-simultaneous submissions could both pass it. Same pattern as the
-- batches_one_live_per_college race guard — enforce at the DB level, not
-- just in app code. Scoped to only submitted/approved so a student can
-- still legitimately resubmit after a rejection.
--
-- Already applied live in Supabase; this file brings the migration
-- history in the repo back in sync with it.
CREATE UNIQUE INDEX IF NOT EXISTS payments_one_active_submission_per_student
  ON payments(student_id) WHERE status IN ('submitted', 'approved');
