-- Migration 0097: FAQ audience for role-based answers.
-- public  = safe for anyone who messages the bot (fees, dates, how to register)
-- student = only for a registered student (their own process questions)
-- admin   = admin-only knowledge, never shown to students or unknown numbers
-- Existing FAQs default to 'public', which is the safe choice: they were
-- written as student-facing answers already.
alter table public.faqs
  add column if not exists audience text not null default 'public'
  check (audience in ('public', 'student', 'admin'));
create index if not exists faqs_audience_idx on public.faqs (audience) where enabled;
