-- Migration 0064: Student App support + notification foundation.
-- Reuses the existing student_queries conversation model instead of adding a
-- second support-ticket subsystem. Contact Support is a priority routed into
-- the same conversation tables; the PWA displays the thread and can receive
-- notification updates through the existing student_notifications system.

ALTER TABLE student_queries
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'student_app'
    CHECK (source IN ('student_app','whatsapp','admin')),
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('normal','high','urgent'));

CREATE INDEX IF NOT EXISTS student_queries_source_status_idx
  ON student_queries (source, status, created_at DESC);
CREATE INDEX IF NOT EXISTS student_queries_student_status_idx
  ON student_queries (student_id, status, created_at DESC);

-- Contact Support is intentionally a system-level category, not a new table.
-- This lets existing admin question tooling continue to work while making
-- support conversations distinguishable from ordinary questions.
UPDATE student_queries
SET category = 'support'
WHERE category = 'general'
  AND source = 'whatsapp'
  AND message IS NOT NULL
  AND lower(message) LIKE 'contact support:%';
