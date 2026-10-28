-- Step 1: quick backup before the move. Run in SQL Editor.
-- Copies the data (not policies/triggers) into a private schema that the API does not expose.
-- Drop it later with: drop schema backup_20261028 cascade;

create schema if not exists backup_20261028;

create table backup_20261028.users     as table public.users;
create table backup_20261028.entries   as table public.entries;
create table backup_20261028.audit_log as table public.audit_log;

-- Should match the live tables (~4, ~6, ~23)
select 'users' t, count(*) from backup_20261028.users
union all select 'entries', count(*) from backup_20261028.entries
union all select 'audit_log', count(*) from backup_20261028.audit_log;
