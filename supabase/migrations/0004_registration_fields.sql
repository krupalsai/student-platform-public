-- Migration: add father_name and college_id_path to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS father_name TEXT,
  ADD COLUMN IF NOT EXISTS college_id_path TEXT;
