-- Migration 0085: in-app support cases (assistant escalation + admin replies).
--
-- student_queries.status was CHECK'd to ('open','answered') while the code
-- already tested for 'resolved' (unreachable). Widened to the full case
-- lifecycle the in-app assistant needs:
--   open          — the assistant is handling it
--   pending_admin — escalated; waiting for the support team
--   answered      — the team replied inside the thread
--   resolved      — closed
ALTER TABLE student_queries DROP CONSTRAINT IF EXISTS student_queries_status_check;
ALTER TABLE student_queries ADD CONSTRAINT student_queries_status_check
  CHECK (status = ANY (ARRAY['open','pending_admin','answered','resolved']));

ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS admin_responded_at timestamptz;
-- Links an escalated thread to the unknown_questions row it created, so an
-- admin answering on WhatsApp (ANSWER <id>) or /admin/questions also lands
-- the answer inside the student's in-app thread.
ALTER TABLE student_queries ADD COLUMN IF NOT EXISTS unknown_question_id uuid
  REFERENCES unknown_questions(id) ON DELETE SET NULL;

-- Per-message metadata: which provider answered, an in-app destination
-- button, whether this message escalated. Never shown raw to students.
ALTER TABLE student_query_messages ADD COLUMN IF NOT EXISTS meta jsonb;

CREATE INDEX IF NOT EXISTS student_queries_status_escalated_idx
  ON student_queries (status, escalated_at DESC);
CREATE INDEX IF NOT EXISTS student_queries_unknown_question_idx
  ON student_queries (unknown_question_id) WHERE unknown_question_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON student_queries, student_query_messages TO service_role;
