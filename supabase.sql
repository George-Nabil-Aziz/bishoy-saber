-- Run once in Supabase Dashboard → SQL Editor

create table if not exists public.entries (
  id          bigint generated always as identity primary key,
  title       text    not null,
  amount      numeric not null,
  notes       text,
  created_at  timestamptz not null default now()
);

alter table public.entries enable row level security;

-- The website may only INSERT. Nobody can read/edit/delete via the public key.
create policy "public can insert"
  on public.entries
  for insert
  to anon
  with check (true);
