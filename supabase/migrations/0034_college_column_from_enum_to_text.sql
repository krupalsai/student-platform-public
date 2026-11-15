-- Migration 0034: convert college columns from the hardcoded college_name
-- enum to TEXT, backed by a real FK to the dynamic colleges table.
--
-- Root cause of registration "internal server error" (e.g. UQ-045):
-- Migration 0033 added a dynamic `colleges` table so new colleges could be
-- added without a code deploy, and app code (src/app/api/profile/route.ts)
-- was updated to validate `college` against that table at request time.
-- But profiles.college / batches.college / unknown_questions.college were
-- never migrated off the old `college_name` ENUM ('GNIT','GNITC' only).
-- So any college added to the `colleges` table that isn't one of those two
-- literal enum values passes app-level validation but is then rejected by
-- Postgres on the actual UPDATE/INSERT with "invalid input value for enum
-- college_name" — surfacing to the student as a generic 500.
--
-- This migration removes that landmine entirely: college columns are now
-- plain TEXT with a foreign key into colleges(id), so the colleges table
-- is the single source of truth and adding a college there just works.

ALTER TABLE profiles
  ALTER COLUMN college TYPE TEXT USING college::TEXT;

ALTER TABLE batches
  ALTER COLUMN college TYPE TEXT USING college::TEXT;

ALTER TABLE unknown_questions
  ALTER COLUMN college TYPE TEXT USING college::TEXT;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_college_fkey
  FOREIGN KEY (college) REFERENCES colleges(id);

ALTER TABLE batches
  ADD CONSTRAINT batches_college_fkey
  FOREIGN KEY (college) REFERENCES colleges(id);

-- unknown_questions.college intentionally has NO fk — it logs whatever a
-- student's session had at the time, and must never fail an insert just
-- because a college was later deactivated/renamed.

-- The old enum type is left in place (harmless, unused) in case anything
-- else references it; nothing above depends on it any more.
