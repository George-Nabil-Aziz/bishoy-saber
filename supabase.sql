-- Run in Supabase Dashboard → SQL Editor (safe to run more than once)

create table if not exists public.entries (
  id          bigint generated always as identity primary key,
  title       text    not null,
  amount      numeric not null,
  notes       text,
  created_at  timestamptz not null default now()
);

alter table public.entries enable row level security;

-- The website can add, list and edit notes (no delete).
drop policy if exists "public can insert" on public.entries;
create policy "public can insert" on public.entries for insert to anon with check (true);

drop policy if exists "public can read" on public.entries;
create policy "public can read" on public.entries for select to anon using (true);

drop policy if exists "public can update" on public.entries;
create policy "public can update" on public.entries for update to anon using (true) with check (true);
