-- Migration 0030: whatsapp_moderation table
-- Backs the ABUSE-intent escalation policy: warn -> 24h auto-restrict on
-- repeat -> admin review if abuse recurs after a restriction already
-- expired. Permanent restriction is an explicit admin action (RESTRICT
-- PERMANENT / UNRESTRICT WhatsApp admin commands), never automatic.
--
-- One row per phone number. Deliberately NOT keyed to profiles(id) —
-- abuse can happen before a student ever registers.
CREATE TABLE IF NOT EXISTS whatsapp_moderation (
  phone                   TEXT        PRIMARY KEY,
  abuse_count             INT         NOT NULL DEFAULT 0,
  last_abuse_at           TIMESTAMPTZ,
  restricted_until        TIMESTAMPTZ,
  restriction_count       INT         NOT NULL DEFAULT 0,
  permanently_restricted  BOOLEAN     NOT NULL DEFAULT false,
  flagged_for_review_at   TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Repeated-identical-message detection (e.g. same text spammed 3x in a
  -- short window). Additive to the original design, not a redesign of it —
  -- same table, same one-row-per-phone shape.
  last_message            TEXT,
  last_message_at         TIMESTAMPTZ,
  repeat_count            INT         NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_moderation_restricted
  ON whatsapp_moderation(restricted_until)
  WHERE restricted_until IS NOT NULL;
ALTER TABLE whatsapp_moderation ENABLE ROW LEVEL SECURITY;
-- Service role only — never exposed to students directly
CREATE POLICY whatsapp_moderation_service_role
  ON whatsapp_moderation FOR ALL TO service_role
  USING (true) WITH CHECK (true);
