-- Migration 0038: short_code for registration_tokens
--
-- Documents schema that was already applied directly to the database —
-- confirmed via information_schema/pg_indexes that both the column and
-- its unique partial index already exist in production. This file exists
-- so `supabase/migrations/` matches live schema, and so a fresh
-- environment (or anyone re-running migrations from scratch) ends up
-- with the same structure. Written as idempotent IF NOT EXISTS /
-- DO $$ ... EXCEPTION checks specifically because it may be run against
-- a database that already has this applied.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'registration_tokens' AND column_name = 'short_code'
  ) THEN
    ALTER TABLE registration_tokens ADD COLUMN short_code TEXT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS registration_tokens_short_code_key
  ON registration_tokens (short_code)
  WHERE short_code IS NOT NULL;
