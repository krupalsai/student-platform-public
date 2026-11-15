-- Migration 0073: make the college directory engineering-only
-- The Student Platform college selector must never use external entity search.

ALTER TABLE public.colleges
  ADD COLUMN IF NOT EXISTS institution_type TEXT NOT NULL DEFAULT 'engineering';

ALTER TABLE public.colleges
  ADD COLUMN IF NOT EXISTS search_aliases TEXT[] NOT NULL DEFAULT '{}';

-- Existing Student Platform college records are engineering colleges.
UPDATE public.colleges
SET institution_type = 'engineering'
WHERE institution_type IS NULL OR institution_type <> 'engineering';

-- Prevent non-engineering entities from entering the directory.
ALTER TABLE public.colleges
  DROP CONSTRAINT IF EXISTS colleges_institution_type_check;

ALTER TABLE public.colleges
  ADD CONSTRAINT colleges_institution_type_check
  CHECK (institution_type = 'engineering');

-- Known short names/codes used by students when searching.
UPDATE public.colleges
SET search_aliases = CASE id
  WHEN 'GNITS' THEN ARRAY['GNITS', 'G NARAYANAMMA', 'GNITS HYDERABAD']
  WHEN 'GNITC' THEN ARRAY['GNITC', 'GNIT COLLEGE']
  WHEN 'GNIT' THEN ARRAY['GNIT']
  WHEN 'BIET' THEN ARRAY['BIET']
  ELSE search_aliases
END;

CREATE INDEX IF NOT EXISTS colleges_active_engineering_idx
  ON public.colleges (active, institution_type, id);
