-- Per-batch group discussion — the in-app replacement for the Telegram group
-- invite (which the approve flow already stopped sending; see auto-approve.ts's
-- "Telegram is no longer used as a student interface, group-invite channel, or
-- notification channel"). Approved students in a batch, plus admins/viewers,
-- can read and post text/photo messages scoped to that one batch.

create table if not exists group_messages (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid        not null references batches(id) on delete cascade,
  sender_id   uuid        not null references profiles(id) on delete cascade,
  sender_name text        not null,
  sender_role text        not null default 'student',   -- 'student' | 'admin' | 'super_admin' (badge only)
  body        text,
  photo_url   text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid        references profiles(id) on delete set null,
  constraint group_messages_has_content check (body is not null or photo_url is not null)
);

create index if not exists group_messages_batch_created_idx
  on group_messages (batch_id, created_at);

alter table group_messages enable row level security;

-- No policies: reached only through the app's service-role client (same
-- convention as route_map_attachments, 0056) — the GRANT below is the part
-- that actually matters (bugs #40/#41: RLS is not a substitute for it).
grant select, insert, update, delete on group_messages to service_role;
