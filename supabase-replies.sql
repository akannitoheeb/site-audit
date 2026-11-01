create table if not exists replies (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  channel text, from_name text, lead_url text, subject text, message text,
  ext_id text unique,
  seen boolean default false
);
alter table replies enable row level security;
