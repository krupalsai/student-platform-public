-- FAQ autopilot (item #222): AI-made drafts are reviewed and published or
-- removed automatically. `source` marks which rows the autopilot may touch,
-- so an FAQ an admin disabled by hand is never re-enabled by it.
alter table public.faqs add column if not exists source text;
alter table public.faqs add column if not exists reviewed_at timestamptz;
alter table public.faqs add column if not exists review_note text;
-- Every disabled row today was created by saveDraftFaq (drafts began 2026-08-25).
update public.faqs set source = 'ai_draft' where enabled = false and source is null;
-- Student thumbs up/down on assistant replies live in student_query_messages.meta.
grant select, insert, update, delete on public.faqs to service_role;
