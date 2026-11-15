-- Migration 0054: allow removed_students.telegram_id to be NULL.
--
-- BUG: the column was NOT NULL, but website-first students have no telegram_id
-- until they open the bot. Deleting such a student failed the archive INSERT
-- with 23502 ("null value in column \"telegram_id\" of relation
-- \"removed_students\" violates not-null constraint") — observed 4x in
-- production runtime logs. The profile delete still went ahead, so the student
-- was removed with NO archive row: the "you were removed because ..." notice
-- could never be shown to them, and the removal record was lost entirely.
--
-- Identity for these students is carried by full_name / roll_number / college.
-- Applied to production via Supabase MCP on 2026-08-05; idempotent.

ALTER TABLE public.removed_students ALTER COLUMN telegram_id DROP NOT NULL;
