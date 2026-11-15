-- Photo + signature (single combined image, as printed on the college
-- petition list per GNIT ID card format) uploaded during registration.
-- Nullable and optional at the DB level — the registration form enforces
-- whether it's required.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo_signature_path TEXT;
