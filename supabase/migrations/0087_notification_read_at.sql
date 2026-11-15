-- 0087: read_at for the in-app notifications inbox (/api/notifications).
alter table public.student_notifications
  add column if not exists read_at timestamptz;
