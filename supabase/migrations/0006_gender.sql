-- Store the student's declared gender for official petition/document exports.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS gender TEXT;

ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_gender_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_gender_check
  CHECK (gender IS NULL OR gender IN ('male', 'female'));

CREATE INDEX IF NOT EXISTS profiles_gender_idx ON profiles(gender);
