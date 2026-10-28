-- Step 4: real sign-in with Supabase Auth. Run in SQL Editor (safe to run more than once).
-- BEFORE running: Dashboard -> Authentication -> Users -> Add user for bishoy.saber@gmail.com
-- (tick "Auto Confirm User") so the owner row below gets linked to it.
-- AFTER running: deploy the edge function "admin-users" (supabase/functions/admin-users/index.ts).
-- Other existing users: an admin opens them in the app (Users -> Edit) and sets a password; that creates their login.
--
-- What changes: the "anon" key can no longer touch any table or bucket; only signed-in members can.
-- Adding and deleting users, and editing another user, go through the edge function (service role).

begin;

-- ---------- Link users to their Auth account, drop the plaintext password ----------

alter table bishoy_saber_notes.users
  add column if not exists auth_id uuid unique references auth.users(id) on delete cascade;

update bishoy_saber_notes.users u set auth_id = au.id
from auth.users au
where lower(au.email) = lower(u.email) and u.auth_id is null;

alter table bishoy_saber_notes.users drop column if exists password;

-- ---------- Helpers (security definer, so they can read users whatever the caller may see) ----------

-- The signed-in member's email (null when not signed in or not in the users table)
create or replace function bishoy_saber_notes.my_email() returns text
language sql stable security definer set search_path = '' as $$
  select email from bishoy_saber_notes.users where auth_id = auth.uid() limit 1
$$;

create or replace function bishoy_saber_notes.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from bishoy_saber_notes.users where auth_id = auth.uid())
$$;

create or replace function bishoy_saber_notes.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from bishoy_saber_notes.users
                 where auth_id = auth.uid() and (role = 'admin' or lower(email) = 'bishoy.saber@gmail.com'))
$$;

revoke execute on function bishoy_saber_notes.my_email(), bishoy_saber_notes.is_member(), bishoy_saber_notes.is_admin() from public, anon;
grant execute on function bishoy_saber_notes.my_email(), bishoy_saber_notes.is_member(), bishoy_saber_notes.is_admin() to authenticated, service_role;

-- ---------- Table rights: nothing for anon ----------

revoke usage on schema bishoy_saber_notes from anon;
revoke all on all tables in schema bishoy_saber_notes from anon;
revoke all on all sequences in schema bishoy_saber_notes from anon;

grant usage on schema bishoy_saber_notes to authenticated, service_role;
grant all on all tables in schema bishoy_saber_notes to service_role;
grant all on all sequences in schema bishoy_saber_notes to service_role;

revoke all on bishoy_saber_notes.entries, bishoy_saber_notes.users, bishoy_saber_notes.audit_log from authenticated;
grant select, insert, update, delete on bishoy_saber_notes.entries to authenticated;
grant usage, select on all sequences in schema bishoy_saber_notes to authenticated;
-- Users: read everyone; a member edits only their own name and photo (the rest goes through the edge function)
grant select on bishoy_saber_notes.users to authenticated;
grant update (name, avatar_url) on bishoy_saber_notes.users to authenticated;
grant select, insert on bishoy_saber_notes.audit_log to authenticated;

-- ---------- Notes ----------

drop policy if exists "public can insert" on bishoy_saber_notes.entries;
drop policy if exists "public can read" on bishoy_saber_notes.entries;
drop policy if exists "public can update" on bishoy_saber_notes.entries;
drop policy if exists "public can delete" on bishoy_saber_notes.entries;
drop policy if exists "members can read notes" on bishoy_saber_notes.entries;
drop policy if exists "members can add notes" on bishoy_saber_notes.entries;
drop policy if exists "owners and admins can edit notes" on bishoy_saber_notes.entries;
drop policy if exists "owners and admins can delete notes" on bishoy_saber_notes.entries;

create policy "members can read notes" on bishoy_saber_notes.entries for select to authenticated
  using (bishoy_saber_notes.is_member());
create policy "members can add notes" on bishoy_saber_notes.entries for insert to authenticated
  with check (bishoy_saber_notes.is_member() and lower(created_by) = lower(bishoy_saber_notes.my_email()));
create policy "owners and admins can edit notes" on bishoy_saber_notes.entries for update to authenticated
  using (bishoy_saber_notes.is_admin() or lower(created_by) = lower(bishoy_saber_notes.my_email()))
  with check (bishoy_saber_notes.is_admin() or lower(created_by) = lower(bishoy_saber_notes.my_email()));
create policy "owners and admins can delete notes" on bishoy_saber_notes.entries for delete to authenticated
  using (bishoy_saber_notes.is_admin() or lower(created_by) = lower(bishoy_saber_notes.my_email()));

-- ---------- Users ----------

drop policy if exists "public can read users" on bishoy_saber_notes.users;
drop policy if exists "public can add users" on bishoy_saber_notes.users;
drop policy if exists "public can delete users" on bishoy_saber_notes.users;
drop policy if exists "public can edit users" on bishoy_saber_notes.users;
drop policy if exists "public can change user photo" on bishoy_saber_notes.users;
drop policy if exists "members can read users" on bishoy_saber_notes.users;
drop policy if exists "members can edit own profile" on bishoy_saber_notes.users;

create policy "members can read users" on bishoy_saber_notes.users for select to authenticated
  using (bishoy_saber_notes.is_member());
-- No insert/delete policy on purpose: only the edge function (service role) adds or removes users
create policy "members can edit own profile" on bishoy_saber_notes.users for update to authenticated
  using (auth_id = auth.uid()) with check (auth_id = auth.uid());

-- The owner can never be deleted, renamed (email) or demoted, even by the edge function
create or replace function bishoy_saber_notes.protect_owner_email() returns trigger
language plpgsql as $$
begin
  if lower(old.email) = 'bishoy.saber@gmail.com' then
    if tg_op = 'DELETE' then
      raise exception 'The owner cannot be deleted';
    end if;
    if lower(new.email) <> lower(old.email) then
      raise exception 'The owner email cannot be changed';
    end if;
    if new.role <> 'admin' then
      raise exception 'The owner must stay an admin';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists protect_owner_email on bishoy_saber_notes.users;
create trigger protect_owner_email before update on bishoy_saber_notes.users
  for each row execute function bishoy_saber_notes.protect_owner_email();

drop trigger if exists protect_owner_delete on bishoy_saber_notes.users;
create trigger protect_owner_delete before delete on bishoy_saber_notes.users
  for each row execute function bishoy_saber_notes.protect_owner_email();

-- ---------- Audit log ----------

drop policy if exists "public can add audit" on bishoy_saber_notes.audit_log;
drop policy if exists "public can read audit" on bishoy_saber_notes.audit_log;
drop policy if exists "members can add audit" on bishoy_saber_notes.audit_log;
drop policy if exists "admins can read audit" on bishoy_saber_notes.audit_log;

create policy "members can add audit" on bishoy_saber_notes.audit_log for insert to authenticated
  with check (bishoy_saber_notes.is_member() and lower(user_email) = lower(bishoy_saber_notes.my_email()));
create policy "admins can read audit" on bishoy_saber_notes.audit_log for select to authenticated
  using (bishoy_saber_notes.is_admin());

-- ---------- Photos and note images ----------
-- The buckets stay public, so <img> tags with the public URL still work without signing in.
-- Listing, uploading, replacing and deleting need a signed-in member.

drop policy if exists "public can upload avatars" on storage.objects;
drop policy if exists "public can read avatars" on storage.objects;
drop policy if exists "public can delete avatars" on storage.objects;
drop policy if exists "public can upload note images" on storage.objects;
drop policy if exists "public can read note images" on storage.objects;
drop policy if exists "public can delete note images" on storage.objects;
drop policy if exists "members can read avatars" on storage.objects;
drop policy if exists "members can upload avatars" on storage.objects;
drop policy if exists "members can update avatars" on storage.objects;
drop policy if exists "members can delete avatars" on storage.objects;
drop policy if exists "members can read note images" on storage.objects;
drop policy if exists "members can upload note images" on storage.objects;
drop policy if exists "members can update note images" on storage.objects;
drop policy if exists "members can delete note images" on storage.objects;

create policy "members can read avatars" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and bishoy_saber_notes.is_member());
create policy "members can upload avatars" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and bishoy_saber_notes.is_member());
create policy "members can update avatars" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and bishoy_saber_notes.is_member())
  with check (bucket_id = 'avatars' and bishoy_saber_notes.is_member());
create policy "members can delete avatars" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and bishoy_saber_notes.is_member());

create policy "members can read note images" on storage.objects for select to authenticated
  using (bucket_id = 'note-images' and bishoy_saber_notes.is_member());
create policy "members can upload note images" on storage.objects for insert to authenticated
  with check (bucket_id = 'note-images' and bishoy_saber_notes.is_member());
create policy "members can update note images" on storage.objects for update to authenticated
  using (bucket_id = 'note-images' and bishoy_saber_notes.is_member())
  with check (bucket_id = 'note-images' and bishoy_saber_notes.is_member());
create policy "members can delete note images" on storage.objects for delete to authenticated
  using (bucket_id = 'note-images' and bishoy_saber_notes.is_member());

-- ---------- Report ----------

do $$
declare
  n int;
begin
  select count(*) into n from bishoy_saber_notes.users where auth_id is null;
  if n > 0 then
    raise notice '% user(s) have no login yet: an admin must open them in Users -> Edit and set a password.', n;
  end if;
  if not exists (select 1 from bishoy_saber_notes.users where lower(email) = 'bishoy.saber@gmail.com' and auth_id is not null) then
    raise warning 'The owner is not linked to an Auth user. Create it in Authentication -> Users, then run this file again.';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- ---------- Rollback (only if you must; it re-opens the database to anyone with the anon key) ----------
-- Revert the code (git revert), then run:
--   begin;
--   alter table bishoy_saber_notes.users add column if not exists password text not null default '';
--   grant usage on schema bishoy_saber_notes to anon;
--   grant select, insert, update, delete on all tables in schema bishoy_saber_notes to anon;
--   -- then re-run the "to anon" policies from the previous supabase.sql (git show HEAD:supabase.sql)
--   commit;
-- Users would need their passwords set again (the old values were not kept).
