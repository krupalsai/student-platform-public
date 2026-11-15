-- Migration 0095: Admin Copilot conversation memory.
--
-- The Copilot used to forget everything on reload and only saw the last few
-- turns the browser chose to send. Each admin's conversation is now stored
-- server-side so it survives reloads, works across the Copilot page and the
-- voice orb, and gives the assistant real context for follow-ups ("show me
-- her ID card"). Per-admin; service-role only (RLS on, no policies).
create table if not exists public.admin_copilot_messages (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_copilot_messages_admin_created_idx
  on public.admin_copilot_messages (admin_id, created_at desc);
alter table public.admin_copilot_messages enable row level security;
