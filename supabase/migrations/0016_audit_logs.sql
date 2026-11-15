-- Migration 0016: audit_logs table
-- Append-only log of all significant system events.
-- Inserted via service role from API routes (never from client).

CREATE TABLE IF NOT EXISTS audit_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  actor_role   TEXT        NOT NULL DEFAULT 'system',
  action       TEXT        NOT NULL,
  target_type  TEXT        NOT NULL,
  target_id    TEXT,
  meta         JSONB       DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor   ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target  ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
-- Service role only — no anon/authenticated client access
