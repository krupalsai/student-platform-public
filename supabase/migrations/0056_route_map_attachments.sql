-- Route Map attachments — admin-uploaded photos and files shown to students
-- inside the Route Map, alongside the hardcoded steps.
--
-- The Route Map's only visual (the HOD letter example) is a file committed to
-- public/route-map/, so adding or correcting one needed a code change and a
-- deploy. This table lets an admin add a reference photo or document from the
-- dashboard, for a college whose steps are already live or (GNITC) still being
-- confirmed.

create table if not exists route_map_attachments (
  id          uuid primary key default gen_random_uuid(),
  college     text        not null,                    -- 'GNIT' | 'GNITC' | 'all'
  title       text        not null,
  description text,
  file_url    text        not null,
  file_name   text,
  file_type   text        not null,                    -- MIME type as uploaded
  kind        text        not null default 'image',    -- 'image' renders inline, 'file' as a download
  step_id     int,                                     -- optional: pin to a Route Map step
  sort_order  int         not null default 0,
  created_by  uuid        references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists route_map_attachments_college_idx
  on route_map_attachments (college, sort_order, created_at);

alter table route_map_attachments enable row level security;

-- No policies: students and admins both reach this only through the app's
-- service-role client, which bypasses RLS. Granting anon/authenticated here
-- would expose it to the public API surface for no benefit.
--
-- The GRANT is the part that has silently broken this project three times
-- (bugs #40/#41): RLS is not a substitute for table privileges, and a new
-- table with no grant returns "permission denied" to the service-role client
-- on every read.
grant select, insert, update, delete on route_map_attachments to service_role;
