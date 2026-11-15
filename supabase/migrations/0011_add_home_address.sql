-- Migration: add home_address to profiles
-- Applied to production via Supabase MCP on 2026-06-16
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS home_address TEXT;
