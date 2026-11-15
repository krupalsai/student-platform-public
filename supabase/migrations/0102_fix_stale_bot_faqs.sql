-- 0102_fix_stale_bot_faqs.sql
-- Fix five stale FAQ answers that the WhatsApp bot was grounding on.
-- The curated knowledge base (src/lib/whatsapp/knowledge-base.ts) already
-- shadows these rows at retrieval time, so the bot answers correctly even
-- before this runs. This migration fixes the stored rows so the admin FAQ
-- list and any other reader of the faqs table see the truth too.
-- Idempotent: safe to run more than once. Run once in the Supabase SQL editor.

-- 1. Fees ARE fixed per batch (batches.fee_amount). The old answer claimed
--    the fee was "not fixed upfront" and the admin would announce it.
UPDATE public.faqs
SET answer = 'The fee depends on your batch: GNIT Batch 2 and GNITC Batch 2 are ₹2,200. GNIT Batch 1 and GNITC Batch 1 are ₹1,100. BIET Batch 1 is ₹2. You pay it on the Payments tab in the Student App.',
    keywords = ARRAY['fee','amount','registration','how much','cost','price']
WHERE question = 'How much is the registration fee';

UPDATE public.faqs
SET answer = 'The fee depends on your batch: GNIT Batch 2 and GNITC Batch 2 are ₹2,200. GNIT Batch 1 and GNITC Batch 1 are ₹1,100. BIET Batch 1 is ₹2. You pay it on the Payments tab in the Student App.',
    keywords = ARRAY['amount','fee','how much','needed']
WHERE question = 'I am asking how much amount needed';

-- 2. Login is OTP-only since 9 Nov 2026. There are no one-time login links
--    any more: a 6-digit code arrives by push notification, or on WhatsApp
--    via VERIFY. The old answer described the retired link flow.
UPDATE public.faqs
SET answer = 'No. The platform has no passwords. You log in with your phone number and a 6-digit one-time code — usually as a notification on your phone, otherwise here on WhatsApp via VERIFY. Type the 6 digits in the app and tap Login. The code expires in 5 minutes.',
    keywords = ARRAY['password','login','log in','otp','code']
WHERE question = 'Do I need a password to log in to the Student Platform?';

-- 3. The live payment gateway is Cashfree (app_settings, 9 Nov 2026),
--    not Razorpay. The old answer named Razorpay.
UPDATE public.faqs
SET answer = 'Pay on the Payments tab in the Student App using UPI, debit card, or credit card. The payment goes through Cashfree. After payment, the system checks the payment automatically.',
    keywords = ARRAY['pay','payment','fee','upi','card','methods']
WHERE question = 'How do I pay the fee? Which payment methods work?';

-- 4. Same retired-link correction for the OTP help answer.
UPDATE public.faqs
SET answer = 'Check that the mobile number you registered with is the same number on your WhatsApp, and that WhatsApp is working. Wait two minutes, then reply VERIFY here and I will send a new 6-digit code. The code expires in 5 minutes.',
    keywords = ARRAY['otp','code','not receiving','whatsapp','login']
WHERE question = 'I am not receiving the OTP or login link on WhatsApp. What do I do?';
