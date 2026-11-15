-- Guarantees "exactly one petition record" per student at the database
-- level — the application only calls createPetitionForStudent once per
-- student in normal operation (guarded by the same !before?.batch_id check
-- that gates first-time batch assignment in /api/profile), but this index
-- is what makes a retry or a future code change fail safely instead of
-- silently creating a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS one_petition_per_student ON petitions (student_id);
