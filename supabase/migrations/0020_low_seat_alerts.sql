-- Low-seat alert threshold per batch. When remaining seats
-- (batch_limit - student_count) drops to or below this number,
-- admins get notified once via Telegram. NULL/0 disables alerts.
ALTER TABLE batches ADD COLUMN IF NOT EXISTS low_seat_alert_threshold INTEGER;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS low_seat_alert_sent_at TIMESTAMPTZ;
