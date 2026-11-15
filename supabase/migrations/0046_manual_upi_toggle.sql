-- Issue #40: admin toggle to enable/disable Manual UPI payments platform-wide,
-- without a redeploy. Stored in the existing app_settings key/value table so
-- the change takes effect immediately everywhere the flag is read (website,
-- WhatsApp student, Telegram student — all land on the same registration page,
-- and the payment API enforces it server-side).
--
-- 'true' (default) = students may choose PhonePe OR Manual UPI.
-- 'false'          = PhonePe only; the QR, UPI ID, Copy, UTR and screenshot
--                    upload are hidden, and manual submissions are rejected.
--
-- PhonePe (instant gateway) is never affected by this flag.

INSERT INTO app_settings (key, value)
VALUES ('manual_upi_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
