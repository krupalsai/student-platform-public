-- App settings table for admin-configurable values
create table if not exists app_settings (
  key   text primary key,
  value text not null,
  updated_at timestamptz default now()
);

-- Seed default UPI settings
insert into app_settings (key, value) values
  ('upi_id',     'not-configured'),
  ('upi_name',   'GNIT Fee'),
  ('upi_amount', '500')
on conflict (key) do nothing;

-- RLS: only service role can access (no client-side access)
alter table app_settings enable row level security;