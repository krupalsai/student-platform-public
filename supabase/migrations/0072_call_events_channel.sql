-- call_events.channel — which transport a call arrived on.
--
-- Until now every row came from Meta's WhatsApp Calling webhook, so the
-- transport was implicit and the table's `wa_call_id` column name said it.
-- The media server now also answers ordinary phone calls through a telephony
-- provider, and those rows need to be distinguishable — for admin reporting,
-- and because the two channels carry different identity guarantees (WhatsApp
-- authenticates the number; PSTN caller ID does not).
--
-- A new column rather than overloading `wa_call_id` or `direction`: a field
-- whose name says WhatsApp quietly holding telephony calls is exactly the kind
-- of confusion this project keeps having to undo later.
--
-- Additive and defaulted, so every existing row is correctly labelled
-- 'whatsapp' and every existing query is unaffected.

ALTER TABLE public.call_events
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

COMMENT ON COLUMN public.call_events.channel IS
  'Transport the call arrived on: whatsapp (Meta Calling API, number authenticated by Meta) or phone (telephony provider, caller ID only — not proof of identity).';

-- Reporting splits by channel constantly ("how many phone calls this week"),
-- and the table grows one row per call forever.
CREATE INDEX IF NOT EXISTS call_events_channel_created_idx
  ON public.call_events (channel, created_at DESC);
