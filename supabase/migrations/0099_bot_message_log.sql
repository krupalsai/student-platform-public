-- Migration 0099: log of incoming WhatsApp messages, used to build and test
-- the bot's intent classifier. Service-role only (RLS on, no policies).
-- Students are told in the bot's welcome text that messages are kept to
-- improve replies.
create table if not exists public.bot_message_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  phone text not null,
  sender_role text not null check (sender_role in ('admin','student','unknown')),
  message text not null,
  label text,
  route text,
  reply_preview text
);
create index if not exists bot_message_log_created_idx on public.bot_message_log (created_at desc);
alter table public.bot_message_log enable row level security;
