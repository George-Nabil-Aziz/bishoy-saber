-- Step 3: move the app's tables from "public" to "bishoy_saber_notes". Run in SQL Editor.
-- RLS policies, indexes, constraints, identity sequences, triggers and column grants move with each table.

begin;

-- Stop if anything else in "public" names these tables (functions or views we don't know about).
-- protect_owner_email is the only known one; it is moved below and does not name a table.
do $$
declare
  found text;
begin
  select string_agg(proname, ', ') into found
  from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname <> 'protect_owner_email'
    and prosrc ~* '\m(users|entries|audit_log)\M';
  if found is not null then
    raise exception 'Review these public functions first: %', found;
  end if;

  select string_agg(distinct v.relname, ', ') into found
  from pg_depend d
  join pg_rewrite r on r.oid = d.objid
  join pg_class v on v.oid = r.ev_class
  where d.refobjid in ('public.users'::regclass, 'public.entries'::regclass, 'public.audit_log'::regclass)
    and v.oid <> d.refobjid;
  if found is not null then
    raise exception 'Review these views first: %', found;
  end if;
end $$;

create schema if not exists bishoy_saber_notes;

alter table public.users     set schema bishoy_saber_notes;
alter table public.entries   set schema bishoy_saber_notes;
alter table public.audit_log set schema bishoy_saber_notes;

-- Trigger function for users (the trigger points at it by id, so it keeps working)
alter function public.protect_owner_email() set schema bishoy_saber_notes;

-- Access for the API roles
grant usage on schema bishoy_saber_notes to anon, authenticated, service_role;
grant all on all tables    in schema bishoy_saber_notes to anon, authenticated, service_role;
grant all on all routines  in schema bishoy_saber_notes to anon, authenticated, service_role;
grant all on all sequences in schema bishoy_saber_notes to anon, authenticated, service_role;

-- "grant all" above re-adds table-wide UPDATE on users; keep it limited to these columns as before
revoke update on bishoy_saber_notes.users from anon, authenticated;
grant update (name, email, password, avatar_url, role) on bishoy_saber_notes.users to anon, authenticated;

-- Same access for anything created in this schema later
alter default privileges for role postgres in schema bishoy_saber_notes
  grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema bishoy_saber_notes
  grant all on routines  to anon, authenticated, service_role;
alter default privileges for role postgres in schema bishoy_saber_notes
  grant all on sequences to anon, authenticated, service_role;

-- Tell the API to reload its schema cache
notify pgrst, 'reload schema';

commit;

-- Check: should list the 3 tables with their row counts
select 'users' t, count(*) from bishoy_saber_notes.users
union all select 'entries', count(*) from bishoy_saber_notes.entries
union all select 'audit_log', count(*) from bishoy_saber_notes.audit_log;
