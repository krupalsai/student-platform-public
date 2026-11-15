-- WhatsApp webhook idempotency.
--
-- Meta retries a webhook delivery whenever it doesn't receive a fast 200
-- (its ack window is only a few seconds) and can also deliver the same
-- message more than once. The handler does all its work — Groq intent
-- classification, Gemini RAG, several DB round-trips and several outbound
-- WhatsApp sends — BEFORE returning 200, so a slow turn easily exceeds
-- Meta's window and gets retried. Re-running the handler for one physical
-- message produces:
--   * duplicate registration links (a fresh token per run),
--   * duplicate college-picker prompts,
--   * duplicate admin notifications,
--   * the general "the bot restarted my conversation" feel.
--
-- Every inbound WhatsApp message carries a globally-unique id (wamid). The
-- webhook now claims that id in this table atomically before processing;
-- a retry finds it already claimed and is dropped. The claim relies on the
-- PRIMARY KEY, so it is race-safe even if two retries arrive concurrently —
-- exactly one INSERT wins.

CREATE TABLE IF NOT EXISTS whatsapp_processed_messages (
  wamid        TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports periodic pruning of old rows (Meta never retries beyond a small
-- window, so anything older than a day is safe to delete).
CREATE INDEX IF NOT EXISTS whatsapp_processed_messages_processed_at_idx
  ON whatsapp_processed_messages(processed_at);

ALTER TABLE whatsapp_processed_messages ENABLE ROW LEVEL SECURITY;
-- Service role only — internal bookkeeping, never exposed to students.
CREATE POLICY whatsapp_processed_messages_service_role
  ON whatsapp_processed_messages FOR ALL TO service_role
  USING (true) WITH CHECK (true);
