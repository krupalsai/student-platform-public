-- Item #229: the second payment opens by itself on a date (15 Oct 2026, when the
-- 0.4% UPI charge above ₹2,000 starts), without an admin switching it on.
alter table public.batches add column if not exists extra_fee_starts_at timestamptz;

update public.batches
   set extra_fee_starts_at = '2026-10-15 00:00:00+05:30'
 where extra_fee_amount is not null and status <> 'closed';
