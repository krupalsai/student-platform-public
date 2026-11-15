-- FAQ Engine: database-driven FAQs (replaces the hardcoded list that lived
-- in src/components/FAQModal.tsx) plus an Unknown Questions queue that
-- dedupes repeat asks of the same not-yet-answered question and lets an
-- admin's answer (via Telegram) turn into a permanent, matchable FAQ.

create table if not exists faqs (
  id uuid primary key default gen_random_uuid(),
  category text,
  question text not null,
  answer text not null,
  keywords text[] not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$ begin
  create type unknown_question_status as enum ('pending','answered','ignored');
exception when duplicate_object then null; end $$;

create table if not exists unknown_questions (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  normalized_question text not null,
  student_phone text,
  college college_name,
  occurrence_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status unknown_question_status not null default 'pending',
  faq_id uuid references faqs(id),
  -- Tracks the Telegram message the admin was notified on, so a plain
  -- reply-to-that-message (no inline state machine needed) answers the
  -- right question even with several pending at once.
  notify_message_id bigint,
  notify_chat_id bigint
);

-- Dedup only applies while a question is still pending; once answered or
-- ignored, a later re-ask starts a fresh row rather than reopening the old one.
create unique index if not exists unknown_questions_normalized_pending
  on unknown_questions (normalized_question) where status = 'pending';

alter table faqs enable row level security;
alter table unknown_questions enable row level security;
create policy faqs_service_role on faqs for all to service_role using (true) with check (true);
create policy unknown_questions_service_role on unknown_questions for all to service_role using (true) with check (true);
