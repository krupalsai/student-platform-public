-- Migration 0014: action_rate_limits table
-- Applied to production via Supabase MCP.
-- Tracks admin actions (approve / reject / resend-invite) per actor+target
-- to support rate limiting and prevent accidental duplicate operations.

CREATE TABLE IF NOT EXISTS action_rate_limits (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID NOT NULL REFERENCES profiles(id),
  action     TEXT NOT NULL,
  target_id  UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_rate_limits_actor_action
  ON action_rate_limits (actor_id, action, created_at);

CREATE INDEX IF NOT EXISTS idx_action_rate_limits_target
  ON action_rate_limits (target_id, action);

ALTER TABLE action_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_rate_limits ON action_rate_limits;
CREATE POLICY service_role_all_rate_limits ON action_rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);
