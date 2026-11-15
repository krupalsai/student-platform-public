-- Migration 0033: colleges table + student_notifications
-- Applied via Supabase MCP 2026-07-29

-- Dynamic college registry (replaces hardcoded enum references in app code)
CREATE TABLE IF NOT EXISTS colleges (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE colleges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read colleges"
  ON colleges FOR SELECT USING (true);
INSERT INTO colleges (id, name) VALUES ('GNIT','GNIT'),('GNITC','GNITC')
ON CONFLICT (id) DO NOTHING;

-- Student auto-notification tracking
CREATE TABLE IF NOT EXISTS student_notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  channel      TEXT NOT NULL,
  message      TEXT NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reference_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_student_notifications_student
  ON student_notifications(student_id, sent_at DESC);
ALTER TABLE student_notifications ENABLE ROW LEVEL SECURITY;
