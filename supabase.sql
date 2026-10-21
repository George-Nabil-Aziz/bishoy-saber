-- Run in Supabase Dashboard → SQL Editor (safe to run more than once)

create table if not exists public.entries (
  id          bigint generated always as identity primary key,
  title       text    not null,
  amount      numeric not null,
  notes       text,
  created_at  timestamptz not null default now()
);

alter table public.entries enable row level security;

-- The website can add, list, edit and delete notes.
drop policy if exists "public can insert" on public.entries;
create policy "public can insert" on public.entries for insert to anon with check (true);

drop policy if exists "public can read" on public.entries;
create policy "public can read" on public.entries for select to anon using (true);

drop policy if exists "public can update" on public.entries;
create policy "public can update" on public.entries for update to anon using (true) with check (true);

drop policy if exists "public can delete" on public.entries;
create policy "public can delete" on public.entries for delete to anon using (true);


-- ---------- Users (who can log in to the website) ----------

create table if not exists public.users (
  id          bigint generated always as identity primary key,
  name        text not null,
  email       text not null unique,
  password    text not null,
  created_at  timestamptz not null default now()
);

alter table public.users enable row level security;

insert into public.users (name, email, password)
values ('Bishoy Saber', 'bishoy.saber@gmail.com', '123456789')
on conflict (email) do nothing;

drop policy if exists "public can read users" on public.users;
create policy "public can read users" on public.users for select to anon using (true);

drop policy if exists "public can add users" on public.users;
create policy "public can add users" on public.users for insert to anon with check (true);

-- Anyone can be removed except the owner
drop policy if exists "public can delete users" on public.users;
create policy "public can delete users" on public.users for delete to anon
  using (lower(email) <> 'bishoy.saber@gmail.com');
