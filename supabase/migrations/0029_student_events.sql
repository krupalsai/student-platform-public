-- Migration 0029: student_events table
-- Product analytics timeline — tracks meaningful student actions in the
-- Telegram Mini App. NOT a debug log. Purpose: understand feature usage,
-- drop-off points, and workflow completion rates.
--
-- Separate from audit_logs (which records admin/system events) — these are
-- student-facing product events only.

CREATE TABLE IF NOT EXISTS student_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID        REFERENCES profiles(id) ON DELETE CASCADE,
  telegram_id  BIGINT,
  batch_id     UUID        REFERENCES batches(id) ON DELETE SET NULL,
  college      TEXT,
  event_type   TEXT        NOT NULL,
  page         TEXT,
  metadata     JSONB       DEFAULT \'{}\',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for the analytics queries we\'ll run:
--   by student (timeline view)
--   by event_type (feature usage counts)
--   by college + event_type (per-college funnel)
--   by created_at (time-range filters)
CREATE INDEX IF NOT EXISTS idx_student_events_student   ON student_events(student_id);
CREATE INDEX IF NOT EXISTS idx_student_events_type      ON student_events(event_type);
CREATE INDEX IF NOT EXISTS idx_student_events_college   ON student_events(college, event_type);
CREATE INDEX IF NOT EXISTS idx_student_events_created   ON student_events(created_at DESC);

ALTER TABLE student_events ENABLE ROW LEVEL SECURITY;
-- Service role only — never exposed to students directly
CREATE POLICY student_events_service_role
  ON student_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);
