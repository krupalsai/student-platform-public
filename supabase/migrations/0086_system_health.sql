-- 0086: system_health — alert-dedupe state for /api/cron/self-watch.
-- One row per check; the watcher alerts on new problems, re-alerts ongoing
-- ones at most daily, and stays silent on recoveries and healthy runs.

create table if not exists public.system_health (
  check_key text primary key,
  status text not null check (status in ('ok', 'problem')),
  detail text,
  updated_at timestamptz not null default now(),
  last_alert_at timestamptz
);

alter table public.system_health enable row level security;

-- Service role (used by the cron route) bypasses RLS. No public policies:
-- anon/authenticated get nothing.
