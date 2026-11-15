-- Migration 0064: store student requests for colleges not yet configured.
CREATE TABLE IF NOT EXISTS college_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  college_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_college_requests_status_created
  ON college_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_college_requests_phone
  ON college_requests(phone);

GRANT SELECT, INSERT, UPDATE ON college_requests TO service_role;
