-- Student-requested AI callback queue.
create table if not exists public.ai_callback_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  phone_number text not null,
  issue_summary text not null,
  conversation_context text,
  status text not null default 'pending' check (status in ('pending','queued','calling','completed','failed','escalated','cancelled')),
  provider text,
  external_call_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  failure_reason text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_callback_requests_student_idx on public.ai_callback_requests(student_id, created_at desc);
create index if not exists ai_callback_requests_status_idx on public.ai_callback_requests(status, created_at);
alter table public.ai_callback_requests enable row level security;
revoke all on public.ai_callback_requests from anon, authenticated;
