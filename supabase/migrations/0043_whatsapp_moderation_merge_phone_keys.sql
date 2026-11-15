-- WhatsApp "context loss" root cause.
--
-- whatsapp_moderation.phone is the PRIMARY KEY, but two code paths wrote it
-- with two different normalisations of the same number:
--   * moderation.ts (name, spam ladder, awaiting-support) used
--     normalizePhone()        -> 10 digits, no country code  ("98XXXXXXXX")
--   * router.ts getLastIntent/setLastIntent used
--     normalizeWhatsAppNumber() -> E.164 with +91           ("+91 98XXXXXXXX")
--
-- Result: every active person ended up with TWO rows — a 10-digit row holding
-- their name + moderation state, and a +91 row holding ONLY last_intent. The
-- conversation-context feature ("How much?" after "Registration") read the
-- +91 row while moderation read the 10-digit row, so the two halves of the
-- same conversation never saw each other.
--
-- The code is being unified onto the 10-digit normalizePhone() form (it
-- matches profiles.phone and is already the majority of rows). This migration
-- merges the existing split rows so no last_intent context is lost, then
-- removes the now-redundant +91 duplicates. The +91 rows were created solely
-- by setLastIntent(), which only ever wrote last_intent columns, so they hold
-- no other state to preserve.
--
-- Idempotent: re-running is a no-op once all rows are in 10-digit form.

-- 1. Carry last_intent from each +91 duplicate onto its canonical 10-digit
--    row, but only when it is genuinely newer / fills a gap.
UPDATE whatsapp_moderation canon
SET    last_intent    = dup.last_intent,
       last_intent_at = dup.last_intent_at
FROM   whatsapp_moderation dup
WHERE  dup.phone LIKE '+%'
  AND  canon.phone NOT LIKE '+%'
  AND  canon.phone = right(regexp_replace(dup.phone, '\D', '', 'g'), 10)
  AND  dup.last_intent IS NOT NULL
  AND  (canon.last_intent_at IS NULL
        OR dup.last_intent_at > canon.last_intent_at);

-- 2. Drop the +91 duplicates that now have a canonical 10-digit counterpart.
DELETE FROM whatsapp_moderation dup
WHERE  dup.phone LIKE '+%'
  AND  EXISTS (
    SELECT 1 FROM whatsapp_moderation canon
    WHERE  canon.phone NOT LIKE '+%'
      AND  canon.phone = right(regexp_replace(dup.phone, '\D', '', 'g'), 10)
  );

-- 3. Any +91 row with NO counterpart (none expected today, but be safe):
--    convert it in place to the canonical 10-digit key instead of deleting,
--    so its state is retained.
UPDATE whatsapp_moderation
SET    phone = right(regexp_replace(phone, '\D', '', 'g'), 10)
WHERE  phone LIKE '+%';
