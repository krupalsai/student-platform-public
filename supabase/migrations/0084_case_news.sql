-- Migration 0084: case_news — public case timeline for every batch.
-- One row = one "what happened, when" event for a batch's writ petition
-- (filing, hearing, order, next hearing date, victory, general update).
-- Every logged-in student sees every batch's news (no per-batch scoping).
create table if not exists public.case_news (
  id uuid primary key default gen_random_uuid(),
  batch_slug text not null,
  college text not null,
  batch_name text not null,
  title text not null,
  body text not null default '',
  event_type text not null default 'update'
    check (event_type in ('filing','hearing','order','next_hearing','victory','update')),
  event_date date not null,
  source_url text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists case_news_event_date_idx on public.case_news(event_date desc);
create index if not exists case_news_batch_idx on public.case_news(batch_slug);
alter table public.case_news enable row level security;
revoke all on public.case_news from anon, authenticated;
