-- AI voice provider accounts and usage router.
create table if not exists public.voice_ai_accounts (
  id uuid primary key default gen_random_uuid(),
  slot smallint not null unique check (slot between 1 and 3),
  provider text not null default 'vapi',
  label text not null,
  enabled boolean not null default false,
  auto_suspended boolean not null default false,
  priority integer not null default 100,
  api_key_env text not null,
  assistant_id text,
  phone_number_id text,
  inbound_number text,
  budget_usd numeric(12,4) not null default 0 check (budget_usd >= 0),
  switch_threshold_usd numeric(12,4) not null default 1 check (switch_threshold_usd >= 0),
  reservation_usd numeric(12,4) not null default 1 check (reservation_usd > 0),
  spent_usd numeric(12,4) not null default 0 check (spent_usd >= 0),
  reserved_usd numeric(12,4) not null default 0 check (reserved_usd >= 0),
  last_usage_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.voice_ai_usage (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.voice_ai_accounts(id) on delete restrict,
  external_call_id text not null,
  direction text not null default 'unknown' check (direction in ('inbound','outbound','unknown')),
  reservation_usd numeric(12,4) not null default 0,
  cost_usd numeric(12,4) not null default 0,
  duration_seconds integer,
  ended_reason text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (account_id, external_call_id)
);

create index if not exists voice_ai_accounts_enabled_priority_idx on public.voice_ai_accounts (enabled, priority, slot);
create index if not exists voice_ai_usage_account_created_idx on public.voice_ai_usage (account_id, created_at desc);
alter table public.voice_ai_accounts enable row level security;
alter table public.voice_ai_usage enable row level security;

create or replace function public.claim_voice_ai_account(p_reservation_usd numeric default null)
returns table (account_id uuid, slot smallint, provider text, api_key_env text, assistant_id text, phone_number_id text, reservation_usd numeric)
language plpgsql security definer set search_path = public
as $$
declare
  chosen public.voice_ai_accounts%rowtype;
  reservation numeric;
begin
  select * into chosen from public.voice_ai_accounts
   where enabled and not auto_suspended and assistant_id is not null and api_key_env <> ''
     and (budget_usd - spent_usd - reserved_usd) > greatest(switch_threshold_usd, coalesce(p_reservation_usd, reservation_usd))
   order by priority, slot for update skip locked limit 1;
  if chosen.id is null then
    select * into chosen from public.voice_ai_accounts
     where enabled and not auto_suspended and assistant_id is not null and api_key_env <> ''
       and (budget_usd - spent_usd - reserved_usd) > coalesce(p_reservation_usd, reservation_usd)
     order by priority, slot for update skip locked limit 1;
  end if;
  if chosen.id is null then return; end if;
  reservation := coalesce(p_reservation_usd, chosen.reservation_usd);
  update public.voice_ai_accounts set reserved_usd = reserved_usd + reservation, updated_at = now(), last_error = null where id = chosen.id;
  return query select chosen.id, chosen.slot, chosen.provider, chosen.api_key_env, chosen.assistant_id, chosen.phone_number_id, reservation;
end;
$$;

create or replace function public.register_voice_ai_call(p_account_id uuid, p_external_call_id text, p_reservation_usd numeric, p_direction text default 'unknown')
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  insert into public.voice_ai_usage(account_id, external_call_id, direction, reservation_usd)
  values (p_account_id, p_external_call_id, coalesce(p_direction,'unknown'), greatest(0,coalesce(p_reservation_usd,0)))
  on conflict (account_id, external_call_id) do nothing;
  return true;
end;
$$;

create or replace function public.release_voice_ai_reservation(p_account_id uuid, p_reservation_usd numeric)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  update public.voice_ai_accounts set reserved_usd = greatest(0, reserved_usd - greatest(0,coalesce(p_reservation_usd,0))), updated_at=now() where id=p_account_id;
  return found;
end;
$$;

create or replace function public.settle_voice_ai_usage(p_account_id uuid, p_external_call_id text, p_cost_usd numeric, p_duration_seconds integer default null, p_ended_reason text default null, p_direction text default 'unknown')
returns boolean language plpgsql security definer set search_path = public
as $$
declare reservation numeric;
begin
  select reservation_usd into reservation from public.voice_ai_usage where account_id=p_account_id and external_call_id=p_external_call_id for update;
  if found then
    update public.voice_ai_usage set cost_usd=greatest(0,coalesce(p_cost_usd,0)), duration_seconds=p_duration_seconds, ended_reason=p_ended_reason, settled_at=now()
     where account_id=p_account_id and external_call_id=p_external_call_id and settled_at is null;
    if found then
      update public.voice_ai_accounts set reserved_usd=greatest(0,reserved_usd-reservation), spent_usd=spent_usd+greatest(0,coalesce(p_cost_usd,0)), last_usage_sync_at=now(), updated_at=now() where id=p_account_id;
      return true;
    end if;
    return false;
  end if;
  insert into public.voice_ai_usage(account_id,external_call_id,direction,reservation_usd,cost_usd,duration_seconds,ended_reason,settled_at)
  values(p_account_id,p_external_call_id,coalesce(p_direction,'unknown'),0,greatest(0,coalesce(p_cost_usd,0)),p_duration_seconds,p_ended_reason,now());
  update public.voice_ai_accounts set spent_usd=spent_usd+greatest(0,coalesce(p_cost_usd,0)),last_usage_sync_at=now(),updated_at=now() where id=p_account_id;
  return true;
end;
$$;

revoke all on function public.claim_voice_ai_account(numeric) from public, anon, authenticated;
revoke all on function public.register_voice_ai_call(uuid,text,numeric,text) from public, anon, authenticated;
revoke all on function public.release_voice_ai_reservation(uuid,numeric) from public, anon, authenticated;
revoke all on function public.settle_voice_ai_usage(uuid,text,numeric,integer,text,text) from public, anon, authenticated;
grant execute on function public.claim_voice_ai_account(numeric) to service_role;
grant execute on function public.register_voice_ai_call(uuid,text,numeric,text) to service_role;
grant execute on function public.release_voice_ai_reservation(uuid,numeric) to service_role;
grant execute on function public.settle_voice_ai_usage(uuid,text,numeric,integer,text,text) to service_role;
