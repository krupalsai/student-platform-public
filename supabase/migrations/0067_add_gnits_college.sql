-- Migration 0067: add GNITS to the college directory
-- The student college selector reads this table dynamically.
INSERT INTO colleges (id, name, active)
VALUES ('GNITS', 'G. Narayanamma Institute of Technology and Science', true)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    active = true;
