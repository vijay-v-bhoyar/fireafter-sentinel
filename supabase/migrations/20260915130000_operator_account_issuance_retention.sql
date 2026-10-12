set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Preserve append-only issuance history when an Auth user is deleted. The old
-- succeeded-event CHECK rejected the NULL produced by ON DELETE SET NULL.
do $$
declare
  v_constraint record;
  v_match_count integer := 0;
begin
  select count(*) into v_match_count
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.operator_account_issuance_events'::regclass
      and c.contype = 'c'
      and position('event_type' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
      and position('succeeded' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
      and position('user_id' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
      and position('not null' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0;
  if v_match_count > 1 then
    raise exception 'Ambiguous succeeded-event constraints; refusing to alter issuance history';
  elsif v_match_count = 1 then
    select c.oid, c.conname into v_constraint
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.operator_account_issuance_events'::regclass
      and c.contype = 'c'
      and position('event_type' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
      and position('succeeded' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
      and position('user_id' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
      and position('not null' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0;
    execute pg_catalog.format(
      'alter table public.operator_account_issuance_events drop constraint %I',
      v_constraint.conname
    );
  end if;
end $$;

-- A succeeded event must identify its Auth user when inserted. Once persisted,
-- the user_id may be nulled only by the retained user's Auth deletion.
create or replace function public.fireafter_validate_operator_account_issuance_event()
returns trigger
language plpgsql
security definer
set search_path = '' set statement_timeout = '10s'
as $$
begin
  if new.event_type = 'succeeded' and new.user_id is null then
    raise exception 'Succeeded issuance event requires an Auth user id' using errcode = '23514';
  end if;
  return new;
end;
$$;
alter function public.fireafter_validate_operator_account_issuance_event() owner to postgres;
revoke all on function public.fireafter_validate_operator_account_issuance_event() from public, anon, authenticated, service_role;

drop trigger if exists fireafter_validate_operator_account_issuance_event on public.operator_account_issuance_events;
create trigger fireafter_validate_operator_account_issuance_event
before insert on public.operator_account_issuance_events
for each row execute function public.fireafter_validate_operator_account_issuance_event();

-- Re-attest the complete current issuance boundary after the retention repair.
create or replace function public.fireafter_operator_account_issuance_audit_security_version()
returns text language sql stable security invoker set search_path = ''
as $$
  with table_controls as (
    select count(*) = 1 and bool_and(c.relkind = 'r' and c.relrowsecurity and c.relowner = 'postgres'::regrole
      and not pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
      and not pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
      and not pg_catalog.has_any_column_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')) valid
    from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.operator_account_issuance_operators')
  ), column_controls as (
    select count(*) = 4 and bool_and(not a.attisdropped and a.atttypid = pg_catalog.to_regtype('pg_catalog.' || r.type_name)
      and a.attnotnull = r.required) valid
    from (values ('operator_account_issuance_attempts','operator_user_id','uuid',false),
      ('operator_account_issuance_attempts','operator_identity_source','text',true),
      ('operator_account_issuance_events','operator_user_id','uuid',false),
      ('operator_account_issuance_events','operator_identity_source','text',true)) r(table_name,column_name,type_name,required)
    join pg_catalog.pg_attribute a on a.attrelid = pg_catalog.to_regclass('public.' || r.table_name)
      and a.attname = r.column_name and a.attnum > 0
  ), helper_controls as (
    select count(*) = 1 and bool_and(p.proowner = 'postgres'::regrole and p.prosecdef
      and p.proconfig = array['search_path=""','statement_timeout=10s']::text[]
      and p.prosrc like '%auth.uid()%' and p.prosrc like '%auth.jwt()%'
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.fireafter_current_trusted_issuance_operator()')
  ), wrapper_controls as (
    select count(*) = 3 and bool_and(p.proowner = 'postgres'::regrole and p.prosecdef
      and p.proconfig in (array['search_path=""','lock_timeout=2s','statement_timeout=20s']::text[], array['search_path=""','statement_timeout=20s']::text[])
      and p.prosrc like '%fireafter_current_trusted_issuance_operator%'
      and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from (values ('public.fireafter_begin_account_issuance_as_operator(uuid,text,uuid,text,text,uuid)'),
      ('public.fireafter_get_account_issuance_as_operator(uuid)'),
      ('public.fireafter_advance_account_issuance_as_operator(uuid,uuid,text)')) r(signature)
    join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(r.signature)
  ), legacy_controls as (
    select count(*) = 3 and bool_and(not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from (values ('public.fireafter_get_account_issuance(uuid)'),
      ('public.fireafter_begin_account_issuance(uuid,text,uuid,text,text,text,uuid)'),
      ('public.fireafter_advance_account_issuance(uuid,uuid,text)')) r(signature)
    join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(r.signature)
  ), retention_controls as (
    select count(*) = 1 and bool_and(c.confdeltype = 'n') valid
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.operator_account_issuance_events'::regclass
      and c.confrelid = 'auth.users'::regclass and c.contype = 'f'
      and c.conkey = array[(select a.attnum from pg_catalog.pg_attribute a
        where a.attrelid = 'public.operator_account_issuance_events'::regclass and a.attname = 'user_id' and a.attnum > 0)]
      and c.confkey = array[(select a.attnum from pg_catalog.pg_attribute a
        where a.attrelid = 'auth.users'::regclass and a.attname = 'id' and a.attnum > 0)]
  ), check_controls as (
    select not exists (
      select 1 from pg_catalog.pg_constraint c
      where c.conrelid = 'public.operator_account_issuance_events'::regclass and c.contype = 'c'
        and position('event_type' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
        and position('succeeded' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
        and position('user_id' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
        and position('not null' in pg_catalog.lower(pg_catalog.pg_get_constraintdef(c.oid))) > 0
    ) valid
  ), trigger_controls as (
    select count(*) = 1 and bool_and(t.tgenabled = 'O' and p.proowner = 'postgres'::regrole and p.prosecdef
      and p.proconfig = array['search_path=""','statement_timeout=10s']::text[]
      and p.prosrc like '%new.event_type = ''succeeded'' and new.user_id is null%'
      and p.prosrc like '%23514%'
      and pg_catalog.pg_get_triggerdef(t.oid) like '%BEFORE INSERT%'
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.operator_account_issuance_events'::regclass
      and not t.tgisinternal and t.tgname = 'fireafter_validate_operator_account_issuance_event'
  ), probe_controls as (
    select count(*) = 1 and bool_and(p.proowner = 'postgres'::regrole and not p.prosecdef
      and p.proconfig = array['search_path=""']::text[]
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')) valid
    from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.fireafter_operator_account_issuance_audit_security_version()')
  )
  select case when table_controls.valid and column_controls.valid and helper_controls.valid
    and wrapper_controls.valid and legacy_controls.valid and retention_controls.valid
    and check_controls.valid and trigger_controls.valid and probe_controls.valid
    then '20260915130000'::text else null::text end
  from table_controls cross join column_controls cross join helper_controls cross join wrapper_controls
    cross join legacy_controls cross join retention_controls cross join check_controls
    cross join trigger_controls cross join probe_controls;
$$;
alter function public.fireafter_operator_account_issuance_audit_security_version() owner to postgres;
revoke all on function public.fireafter_operator_account_issuance_audit_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_operator_account_issuance_audit_security_version() to service_role;

do $$ begin
  if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260915130000' then
    raise exception 'Operator issuance retention controls not verified; review the FK, insertion trigger and trusted boundary before retrying';
  end if;
end $$;
