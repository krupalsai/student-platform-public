-- Migration 0082: hall_live_alerts — one row per batch per day the first time
-- its judge's hall is seen streaming, so the "hall is live" Telegram alert
-- fires exactly once per batch per listing day and never spams on re-checks.
create table if not exists public.hall_live_alerts (
  id uuid primary key default gen_random_uuid(),
  batch_slug text not null,
  alert_date date not null,
  court_code text not null,
  hall_name text not null,
  students_notified integer not null default 0,
  created_at timestamptz not null default now(),
  unique (batch_slug, alert_date)
);
create index if not exists hall_live_alerts_date_idx on public.hall_live_alerts(alert_date desc);
alter table public.hall_live_alerts enable row level security;
revoke all on public.hall_live_alerts from anon, authenticated;
