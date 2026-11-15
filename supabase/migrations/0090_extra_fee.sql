-- Second, separate charge per batch (e.g. ₹200 collected after the main
-- ₹2,000). Kept OUT of `payments` on purpose: every "paid" count, the court
-- exhibit, approvals and announcements read `payments`, and none of them
-- should change because of this charge.
alter table public.batches
  add column if not exists extra_fee_amount numeric,
  add column if not exists extra_fee_label text,
  add column if not exists extra_fee_note text,
  add column if not exists extra_fee_enabled boolean not null default false;

create table if not exists public.extra_fee_payments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  amount numeric not null,
  status text not null default 'pending' check (status in ('pending','paid','failed')),
  razorpay_order_id text unique,
  razorpay_payment_id text,
  utr text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists extra_fee_payments_student_idx on public.extra_fee_payments(student_id);
create index if not exists extra_fee_payments_batch_idx on public.extra_fee_payments(batch_id);
create unique index if not exists extra_fee_payments_one_paid
  on public.extra_fee_payments(student_id, batch_id) where status = 'paid';

alter table public.extra_fee_payments enable row level security;
grant select, insert, update, delete on public.extra_fee_payments to service_role;
