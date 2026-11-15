-- Migration 0018: announcements table
-- Applied via Supabase MCP on 2026-06-24
CREATE TABLE IF NOT EXISTS announcements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  college     TEXT DEFAULT 'all',
  priority    TEXT DEFAULT 'normal',
  created_by  UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ
);
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "students read active announcements"
  ON announcements FOR SELECT
  USING (expires_at IS NULL OR expires_at > now());
