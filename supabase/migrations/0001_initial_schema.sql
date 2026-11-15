-- Initial Student Platform Schema
create table profiles (
  id uuid primary key,
  telegram_id bigint unique,
  full_name text,
  username text,
  role text not null default 'student',
  created_at timestamptz default now()
);

create table batches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_at timestamptz default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  amount numeric(10,2),
  upi_reference text,
  verified boolean default false,
  created_at timestamptz default now()
);