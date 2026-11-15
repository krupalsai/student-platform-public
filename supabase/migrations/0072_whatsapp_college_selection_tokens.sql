-- Secure short-lived tokens used when a student selects a college in the web fallback.
create table if not exists public.whatsapp_college_selection_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  phone text not null,
  college_id text not null,
  college_name text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_college_selection_tokens_phone_idx
  on public.whatsapp_college_selection_tokens(phone);
create index if not exists whatsapp_college_selection_tokens_expires_idx
  on public.whatsapp_college_selection_tokens(expires_at);
alter table public.whatsapp_college_selection_tokens enable row level security;

-- The college-selection API uses the Supabase service role to issue and
-- consume short-lived tokens. RLS does not replace table-level privileges.
grant select, insert, update on table public.whatsapp_college_selection_tokens to service_role;
