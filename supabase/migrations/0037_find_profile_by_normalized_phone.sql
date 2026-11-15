-- Critical fix: /api/registration-tokens/start calls
-- db.rpc("find_profile_by_normalized_phone", ...) to find-or-create a
-- profile by phone without ever duplicating one, but this function had
-- never actually been created live — the route's error was silently
-- discarded, so every call fell through to "not found" and always tried
-- to create a new profile, defeating the no-duplicate-profile design and
-- hard-failing on any student's second attempt via the unique phone index.
--
-- profiles.phone is always normalized to bare 10-digit at write time, so
-- this is a simple exact match.
CREATE OR REPLACE FUNCTION find_profile_by_normalized_phone(p_phone text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM profiles WHERE phone = p_phone LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION find_profile_by_normalized_phone(text) FROM PUBLIC;
