-- Migration 0093: Admin batch assignments for batch-scoped isolation.
-- Normal admins can only access batches explicitly assigned to them.
-- Super admins bypass (no rows needed).
create table if not exists public.admin_batch_assignments (
  admin_id uuid not null references public.profiles(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  granted_by uuid references public.profiles(id),
  granted_at timestamptz not null default now(),
  primary key (admin_id, batch_id)
);
create index if not exists admin_batch_assignments_batch_idx on public.admin_batch_assignments(batch_id);
grant select, insert, update, delete on public.admin_batch_assignments to service_role;
