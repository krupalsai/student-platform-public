-- Migration 0055: short-lived, batch-scoped export download tokens.
--
-- The DOCX/ZIP export routes are admin-gated, but a WhatsApp admin tapping a
-- link has no website session to authenticate with. Rather than weaken those
-- routes, the WhatsApp End Batch flow mints a token authorising download of ONE
-- batch's export for a short window (EXPORT_TOKEN_TTL_MINUTES, default 60).
-- Only the SHA-256 hash is stored, so a leak of this table yields no working
-- links. Applied to production via Supabase MCP on 2026-08-05; idempotent.

CREATE TABLE IF NOT EXISTS export_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT NOT NULL UNIQUE,
  batch_id    UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  created_by  TEXT,                      -- admin phone (WhatsApp) or profile id
  expires_at  TIMESTAMPTZ NOT NULL,
  used_count  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_export_tokens_hash ON export_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_export_tokens_expires ON export_tokens (expires_at);

ALTER TABLE export_tokens ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.export_tokens TO service_role;
REVOKE ALL ON public.export_tokens FROM anon, authenticated;

DROP POLICY IF EXISTS export_tokens_service_role ON export_tokens;
CREATE POLICY export_tokens_service_role ON export_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);
