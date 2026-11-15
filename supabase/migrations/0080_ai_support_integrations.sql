-- AI support integration foundation: Wajo/Fo + CRM/task systems.
-- External systems are mirrors/escalation tools only. Supabase remains the source of truth.

create table if not exists public.integration_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('hubspot','asana','granola','wajo')),
  event_type text not null,
  entity_type text,
  entity_id text,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  request_id text,
  external_id text,
  payload jsonb not null default '{}'::jsonb,
  response jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists integration_events_provider_created_idx
  on public.integration_events(provider, created_at desc);

create index if not exists integration_events_entity_idx
  on public.integration_events(entity_type, entity_id);

alter table public.integration_events enable row level security;

-- Service-role only. No student/client access.
drop policy if exists "integration_events_service_role_only" on public.integration_events;
create policy "integration_events_service_role_only"
  on public.integration_events
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
