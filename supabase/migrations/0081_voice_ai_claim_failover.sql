-- Retry failed voice-provider claims without re-selecting the provider that just failed.
create or replace function public.claim_voice_ai_account(
  p_reservation_usd numeric default null,
  p_exclude_account_id uuid default null
)
returns table (account_id uuid, slot smallint, provider text, api_key_env text, assistant_id text, phone_number_id text, reservation_usd numeric)
language plpgsql security definer set search_path = public
as $$
declare
  chosen public.voice_ai_accounts%rowtype;
  reservation numeric;
begin
  select v.* into chosen from public.voice_ai_accounts v
  where v.enabled and not v.auto_suspended and v.assistant_id is not null and v.api_key_env <> ''
    and (p_exclude_account_id is null or v.id <> p_exclude_account_id)
    and (v.budget_usd - v.spent_usd - v.reserved_usd) > greatest(v.switch_threshold_usd, coalesce(p_reservation_usd, v.reservation_usd))
  order by v.priority, v.slot for update skip locked limit 1;

  if chosen.id is null then
    select v.* into chosen from public.voice_ai_accounts v
    where v.enabled and not v.auto_suspended and v.assistant_id is not null and v.api_key_env <> ''
      and (p_exclude_account_id is null or v.id <> p_exclude_account_id)
      and (v.budget_usd - v.spent_usd - v.reserved_usd) > coalesce(p_reservation_usd, v.reservation_usd)
    order by v.priority, v.slot for update skip locked limit 1;
  end if;

  if chosen.id is null then return; end if;
  reservation := coalesce(p_reservation_usd, chosen.reservation_usd);

  update public.voice_ai_accounts
  set reserved_usd = reserved_usd + reservation, updated_at = now(), last_error = null
  where id = chosen.id;

  return query select chosen.id, chosen.slot, chosen.provider, chosen.api_key_env, chosen.assistant_id, chosen.phone_number_id, reservation;
end;
$$;

revoke all on function public.claim_voice_ai_account(numeric, uuid) from public, anon, authenticated;
grant execute on function public.claim_voice_ai_account(numeric, uuid) to service_role;
