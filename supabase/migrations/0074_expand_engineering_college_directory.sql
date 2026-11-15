-- Migration 0074: expand engineering college directory metadata
-- Keeps the existing colleges table as the source of truth while adding
-- searchable metadata required by the student registration college picker.

ALTER TABLE public.colleges
  ADD COLUMN IF NOT EXISTS normalized_name TEXT,
  ADD COLUMN IF NOT EXISTS college_code TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS district TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT;

UPDATE public.colleges
SET normalized_name = lower(regexp_replace(trim(name), '[^[:alnum:]]+', ' ', 'g'))
WHERE normalized_name IS NULL OR normalized_name = '';

UPDATE public.colleges
SET college_code = id
WHERE college_code IS NULL OR college_code = '';

CREATE INDEX IF NOT EXISTS colleges_engineering_search_idx
  ON public.colleges (active, institution_type, normalized_name);

CREATE INDEX IF NOT EXISTS colleges_engineering_code_idx
  ON public.colleges (college_code);

-- Ensure the existing not-listed flow explicitly remains pending-only.
ALTER TABLE public.college_requests
  DROP CONSTRAINT IF EXISTS college_requests_status_check;

ALTER TABLE public.college_requests
  ADD CONSTRAINT college_requests_status_check
  CHECK (status IN ('pending','approved','rejected'));
