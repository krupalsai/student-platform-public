-- Migration 0094: Missed-call lead capture.
--
-- A missed call to the platform number is reported by the detector (an
-- Android app on the business phone, or any system that can POST — see
-- docs/missed-call-leads.md) to POST /api/missed-call, which creates a row
-- here. The WhatsApp bot then runs a short collection chat with the caller
-- (need → area → name → urgency, tracked by `step`), and the completed lead
-- appears in the admin area at /admin/call-leads.
--
-- Access is service-role only, like the rest of the platform: RLS is enabled
-- with NO policies, so anon/authenticated reach nothing and only the
-- server-side service_role key (which bypasses RLS) can read or write.
create table if not exists public.missed_call_leads (
  id uuid primary key default gen_random_uuid(),
  caller_phone text not null,
  caller_name text,
  need text,
  area text,
  urgency text,
  status text not null default 'New',
  step text not null default 'problem',
  source text default 'missed_call',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists missed_call_leads_caller_phone_idx
  on public.missed_call_leads(caller_phone);

alter table public.missed_call_leads enable row level security;

grant select, insert, update, delete on public.missed_call_leads to service_role;
