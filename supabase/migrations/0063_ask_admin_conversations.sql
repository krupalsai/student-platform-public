-- Migration 0063: Ask Admin becomes a conversation.
--
-- NOTE: already live in production (applied directly via Supabase MCP in an
-- earlier session). This file records it in the repo's migration history;
-- re-running it is a no-op.
--
-- WHAT WAS THERE: /api/queries inserted a student_queries row and nothing in
-- the codebase ever read it back. No reply path, no thread, no way for a
-- student to see what they had asked.
--
-- WHAT THIS ADDS: student_queries becomes the thread header (status, batch,
-- who last spoke, when answered) and student_query_messages holds the turns.
-- The existing row's text is backfilled as the first turn.
--
-- IDS ARE NEVER SUPPLIED BY THE STUDENT. batch_id is stamped server-side from
-- the profile; the API takes only the text of the question.

ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS batch_id        uuid REFERENCES batches(id) ON DELETE SET NULL;
ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS college         text;
ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS last_message_at timestamptz;
ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS last_sender     text;
ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS answered_at     timestamptz;
ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS answered_by     uuid REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS resolved_at     timestamptz;

CREATE INDEX IF NOT EXISTS student_queries_student_idx  ON student_queries (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS student_queries_status_idx   ON student_queries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS student_queries_batch_idx    ON student_queries (batch_id);

CREATE TABLE IF NOT EXISTS student_query_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id   uuid NOT NULL REFERENCES student_queries(id) ON DELETE CASCADE,
  sender     text NOT NULL CHECK (sender IN ('student','admin')),
  author_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_query_messages_thread_idx
  ON student_query_messages (query_id, created_at);

INSERT INTO student_query_messages (query_id, sender, body, created_at)
SELECT q.id, 'student', q.message, q.created_at
FROM student_queries q
WHERE NOT EXISTS (SELECT 1 FROM student_query_messages m WHERE m.query_id = q.id);

UPDATE student_queries
SET last_message_at = COALESCE(last_message_at, created_at),
    last_sender     = COALESCE(last_sender, 'student')
WHERE last_message_at IS NULL OR last_sender IS NULL;

ALTER TABLE student_query_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON student_query_messages FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_query_messages TO service_role;
