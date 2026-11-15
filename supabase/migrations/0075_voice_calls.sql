-- In-app voice calls: student ⇄ admin, over WebRTC.
--
-- ── Why this CAN run on Vercel, when media-server/README.md says it cannot ──
-- That README's constraint is about Meta's WhatsApp calls, where OUR server is
-- one ENDPOINT of the RTP stream and has to hold audio open for minutes. A
-- serverless function genuinely cannot do that.
--
-- Here both endpoints are browsers — the student's and the admin's — and the
-- audio flows directly between them, peer to peer. Vercel never touches the
-- media. It only relays SIGNALLING: a handful of small JSON rows exchanged
-- during the few seconds of call setup. That is ordinary request/response
-- work. Do not "fix" this by reaching for the media server; it is not in the
-- path and does not need to be.
--
-- Hence two tables and no socket:
--   voice_calls        — one row per call; the state machine both sides poll
--   voice_call_signals — SDP offer/answer + ICE candidates, append-only
--
-- Signals are append-only and read with a cursor (id > since) rather than
-- deleted on read. A dropped poll response therefore cannot lose an ICE
-- candidate and silently strand the call — the next poll re-reads from the
-- same cursor.

create table if not exists voice_calls (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references profiles(id) on delete cascade,
  batch_id      uuid references batches(id) on delete set null,
  -- Set when an admin answers. Null while ringing: a call is offered to every
  -- admin at once and the first to accept claims it.
  admin_id      uuid references profiles(id) on delete set null,
  status        text not null default 'ringing'
                  check (status in ('ringing','accepted','declined','ended','missed')),
  reason        text,
  created_at    timestamptz not null default now(),
  answered_at   timestamptz,
  ended_at      timestamptz,
  duration_secs integer,
  -- 'student' | 'admin' | 'timeout' — who hung up, for the admin call log.
  ended_by      text
);

create table if not exists voice_call_signals (
  id         bigserial primary key,
  call_id    uuid not null references voice_calls(id) on delete cascade,
  sender     text not null check (sender in ('student','admin')),
  -- 'sfu' carries {sessionId, trackName}: the two facts each side needs to
  -- subscribe to the other's audio on the Cloudflare Realtime SFU. The SDP
  -- kinds are exchanged with Cloudflare directly (via /api/group-call), not
  -- through this table, and are kept here only so the constraint does not have
  -- to change if a direct peer-to-peer path is ever added back.
  kind       text not null check (kind in ('offer','answer','ice','sfu')),
  payload    jsonb not null,
  created_at timestamptz not null default now()
);

-- The admin console polls for ringing calls; both sides poll their own history.
create index if not exists voice_calls_status_created_idx on voice_calls (status, created_at desc);
create index if not exists voice_calls_student_created_idx on voice_calls (student_id, created_at desc);
-- The hot path: "everything on this call after cursor N", every ~1s per party.
create index if not exists voice_call_signals_call_id_idx on voice_call_signals (call_id, id);

alter table voice_calls enable row level security;
alter table voice_call_signals enable row level security;

-- Grants, not just RLS. Items #40/#41: an RLS policy is NOT a substitute for a
-- table GRANT — those bugs blanked the whole admin payment queue because the
-- service-role app had policies but no grant. service_role ONLY: these rows
-- carry who called whom and when, and the anon key must never see them.
grant select, insert, update, delete on voice_calls to service_role;
grant select, insert, update, delete on voice_call_signals to service_role;
grant usage, select on sequence voice_call_signals_id_seq to service_role;
