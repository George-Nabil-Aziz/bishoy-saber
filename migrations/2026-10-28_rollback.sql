-- Rollback: move the tables back to "public". Run in SQL Editor, then revert the code
-- (git revert of the schema commit) so js/core.js uses the default schema again.

begin;

alter table bishoy_saber_notes.users     set schema public;
alter table bishoy_saber_notes.entries   set schema public;
alter table bishoy_saber_notes.audit_log set schema public;

alter function bishoy_saber_notes.protect_owner_email() set schema public;

notify pgrst, 'reload schema';

commit;

-- The empty schema can stay (harmless) or be removed once you are sure:
-- drop schema bishoy_saber_notes;
