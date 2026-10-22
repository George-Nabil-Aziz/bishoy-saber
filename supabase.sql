-- Run in Supabase Dashboard → SQL Editor (safe to run more than once)

create table if not exists public.entries (
  id          bigint generated always as identity primary key,
  title       text    not null,
  amount      numeric,
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


-- ---------- User photos ----------

alter table public.users add column if not exists avatar_url text;

-- The website can edit a user's name, email, password and photo
revoke update on public.users from anon;
grant update (name, email, password, avatar_url) on public.users to anon;

drop policy if exists "public can change user photo" on public.users;
drop policy if exists "public can edit users" on public.users;
create policy "public can edit users" on public.users for update to anon using (true) with check (true);

-- The owner's email can never change (the delete protection above depends on it)
create or replace function public.protect_owner_email() returns trigger
language plpgsql as $$
begin
  if lower(old.email) = 'bishoy.saber@gmail.com' and lower(new.email) <> lower(old.email) then
    raise exception 'The owner email cannot be changed';
  end if;
  return new;
end $$;

drop trigger if exists protect_owner_email on public.users;
create trigger protect_owner_email before update on public.users
  for each row execute function public.protect_owner_email();

-- Public bucket for the photos (5 MB max, images only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "public can upload avatars" on storage.objects;
create policy "public can upload avatars" on storage.objects for insert to anon with check (bucket_id = 'avatars');

drop policy if exists "public can read avatars" on storage.objects;
create policy "public can read avatars" on storage.objects for select to anon using (bucket_id = 'avatars');

drop policy if exists "public can delete avatars" on storage.objects;
create policy "public can delete avatars" on storage.objects for delete to anon using (bucket_id = 'avatars');


-- ---------- Note images ----------

alter table public.entries add column if not exists image_url text;

-- Public bucket for note images (10 MB max, images only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('note-images', 'note-images', true, 10485760, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "public can upload note images" on storage.objects;
create policy "public can upload note images" on storage.objects for insert to anon with check (bucket_id = 'note-images');

drop policy if exists "public can read note images" on storage.objects;
create policy "public can read note images" on storage.objects for select to anon using (bucket_id = 'note-images');

drop policy if exists "public can delete note images" on storage.objects;
create policy "public can delete note images" on storage.objects for delete to anon using (bucket_id = 'note-images');


-- ---------- The number on a note is optional ----------

alter table public.entries alter column amount drop not null;


-- ---------- Roles ----------

alter table public.users add column if not exists role text not null default 'user';
alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check check (role in ('admin', 'user'));

update public.users set role = 'admin' where lower(email) = 'bishoy.saber@gmail.com';

-- The website can also edit the role
grant update (name, email, password, avatar_url, role) on public.users to anon;


-- ---------- Who created / changed a note ----------

alter table public.entries add column if not exists created_by text;
alter table public.entries add column if not exists updated_at timestamptz not null default now();
alter table public.entries add column if not exists updated_by text;


-- ---------- Audit log (History page) ----------

create table if not exists public.audit_log (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  user_email   text,
  user_name    text,
  action       text,
  target_type  text,
  target_id    text,
  details      jsonb
);

alter table public.audit_log enable row level security;

drop policy if exists "public can add audit" on public.audit_log;
create policy "public can add audit" on public.audit_log for insert to anon with check (true);

drop policy if exists "public can read audit" on public.audit_log;
create policy "public can read audit" on public.audit_log for select to anon using (true);
