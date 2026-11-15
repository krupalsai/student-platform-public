-- Stage 1 of the self-learning knowledge system: adds only the 3 columns
-- unknown_questions is missing for the admin-reply workflow. Nothing else
-- about this table changes — existing status enum, dedup index, and
-- notify_message_id/notify_chat_id (Telegram-era columns, left as-is and
-- simply unused going forward) are untouched.

-- Human-friendly display ID (UQ-001, UQ-002, ...) for admins to reference
-- in a WhatsApp reply. Backed by a real sequence so concurrent inserts can
-- never collide or reuse a number — safer than computing count(*)+1 by hand.
CREATE SEQUENCE IF NOT EXISTS unknown_questions_short_id_seq;

ALTER TABLE unknown_questions
  ADD COLUMN IF NOT EXISTS short_id TEXT,
  ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS answered_by TEXT; -- the admin's WhatsApp number that sent the ANSWER command

-- Backfill short_id for any existing rows (there are some — occurrence
-- data already exists in production) before making it required.
UPDATE unknown_questions
SET short_id = 'UQ-' || lpad(nextval('unknown_questions_short_id_seq')::text, 3, '0')
WHERE short_id IS NULL;

ALTER TABLE unknown_questions
  ALTER COLUMN short_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unknown_questions_short_id_unique
  ON unknown_questions (short_id);

-- Auto-assign short_id on every future insert, so application code never
-- has to compute it — this also makes it impossible for a future code
-- change to insert a row without one.
CREATE OR REPLACE FUNCTION assign_unknown_question_short_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.short_id IS NULL THEN
    NEW.short_id := 'UQ-' || lpad(nextval('unknown_questions_short_id_seq')::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_unknown_question_short_id ON unknown_questions;
CREATE TRIGGER trg_assign_unknown_question_short_id
  BEFORE INSERT ON unknown_questions
  FOR EACH ROW
  EXECUTE FUNCTION assign_unknown_question_short_id();
