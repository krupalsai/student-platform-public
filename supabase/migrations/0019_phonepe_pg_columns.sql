-- Migration: 0019_phonepe_pg_columns.sql
-- Adds PhonePe Payment Gateway columns to the payments table
-- and adds pg_pending / pg_failed to the payment_status enum

-- Add new status values to existing enum
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'pg_pending';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'pg_failed';

-- Add PhonePe-specific columns to payments table
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS phonepe_merchant_txn_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS phonepe_txn_id           TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at             TIMESTAMPTZ;

-- Index for fast webhook lookup
CREATE INDEX IF NOT EXISTS idx_payments_phonepe_merchant_txn
  ON payments (phonepe_merchant_txn_id)
  WHERE phonepe_merchant_txn_id IS NOT NULL;

-- Index for status polling
CREATE INDEX IF NOT EXISTS idx_payments_student_status
  ON payments (student_id, status);
