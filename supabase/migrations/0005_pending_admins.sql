-- Migration 0005: Pending Admins
-- Stores pre-authorized Telegram IDs that become admin/viewer on first login
CREATE TABLE IF NOT EXISTS pending_admins (
  telegram_id BIGINT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
