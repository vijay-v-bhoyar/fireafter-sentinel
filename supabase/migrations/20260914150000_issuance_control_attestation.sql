set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Forward candidate. Preserve ledger data; reconcile inherited grants rather than
-- widening authority. The coordinator uses postgres-owned SECURITY DEFINER RPCs.
revoke all on table public.operator_account_issuance_events,
  public.operator_account_issuance_attempts, public.operator_account_membership_versions
from public, anon, authenticated, service_role;
grant insert on table public.operator_account_issuance_events to service_role;

create or replace function public.fireafter_operator_account_issuance_audit_security_version()
returns text language sql stable security invoker set search_path = ''
as $$
  with protected_tables(table_name, service_insert) as (
    values ('operator_account_issuance_events', true),
      ('operator_account_issuance_attempts', false), ('operator_account_membership_versions', false)
  ), table_controls as (
    select count(*) = 3 and bool_and(coalesce(
      c.relkind = 'r' and c.relrowsecurity and c.relowner = 'postgres'::regrole
      and not pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
      and not pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
      and not pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not pg_catalog.has_any_column_privilege('service_role', c.oid, 'SELECT,UPDATE,REFERENCES')
      and pg_catalog.has_table_privilege('service_role', c.oid, 'INSERT') = t.service_insert
      and (t.service_insert or not pg_catalog.has_any_column_privilege('service_role', c.oid, 'INSERT'))
      and not exists(select 1 from pg_catalog.pg_trigger tr where tr.tgrelid = c.oid and not tr.tgisinternal)
      and not exists(select 1 from pg_catalog.pg_rewrite rw where rw.ev_class = c.oid)
    , false)) as valid
    from protected_tables t join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass('public.' || t.table_name)
  ), required_columns(table_name, column_name, type_name, required) as (
    values ('operator_account_issuance_events','id','uuid',true),
      ('operator_account_issuance_events','attempt_id','uuid',true),
      ('operator_account_issuance_events','user_id','uuid',false),
      ('operator_account_issuance_events','event_type','text',true),
      ('operator_account_issuance_events','failure_code','text',false),
      ('operator_account_issuance_attempts','attempt_id','uuid',true),
      ('operator_account_issuance_attempts','state','text',true),
      ('operator_account_issuance_attempts','user_id','uuid',false),
      ('operator_account_issuance_attempts','completed_at','timestamptz',false),
      ('operator_account_issuance_attempts','membership_generation','int8',true),
      ('operator_account_membership_versions','organization_id','uuid',true),
      ('operator_account_membership_versions','user_id','uuid',true),
      ('operator_account_membership_versions','generation','int8',true)
  ), column_controls as (
    select count(*) = 13 and bool_and(coalesce(a.atttypid = pg_catalog.to_regtype('pg_catalog.' || r.type_name)
      and a.attnotnull = r.required and not a.attisdropped and a.attgenerated = '', false)) as valid
    from required_columns r join pg_catalog.pg_attribute a
      on a.attrelid = pg_catalog.to_regclass('public.' || r.table_name) and a.attname = r.column_name and a.attnum > 0
  ), required_checks(table_name, definition) as (
    values
      ('operator_account_issuance_events', $c$CHECK (((event_type = 'failed'::text) = (failure_code IS NOT NULL)))$c$),
      ('operator_account_issuance_events', $c$CHECK (((event_type <> 'succeeded'::text) OR (user_id IS NOT NULL)))$c$),
      ('operator_account_issuance_events', $c$CHECK ((event_type = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])))$c$),
      ('operator_account_issuance_attempts', $c$CHECK (((state = 'succeeded'::text) = (completed_at IS NOT NULL)))$c$),
      ('operator_account_issuance_attempts', $c$CHECK (((state = 'auth_pending'::text) OR (user_id IS NOT NULL)))$c$),
      ('operator_account_issuance_attempts', $c$CHECK ((state = ANY (ARRAY['auth_pending'::text, 'membership_committed'::text, 'succeeded'::text])))$c$),
      ('operator_account_membership_versions', $c$CHECK ((generation > 0))$c$)
  ), check_controls as (
    select bool_and(exists(select 1 from pg_catalog.pg_constraint c
      where c.conrelid = pg_catalog.to_regclass('public.' || r.table_name) and c.contype = 'c'
        and c.convalidated and not c.connoinherit and pg_catalog.pg_get_constraintdef(c.oid, false) = r.definition)) as valid
    from required_checks r
  ), required_indexes(table_name, keys, is_primary, predicate) as (
    values ('operator_account_issuance_events', array['id']::text[], true, null::text),
      ('operator_account_issuance_events', array['attempt_id','event_type']::text[], false, null::text),
      ('operator_account_issuance_events', array['attempt_id']::text[], false, $c$(event_type = ANY (ARRAY['succeeded'::text, 'failed'::text]))$c$),
      ('operator_account_issuance_attempts', array['attempt_id']::text[], true, null::text),
      ('operator_account_issuance_attempts', array['email_hash']::text[], false, $c$(state <> 'succeeded'::text)$c$),
      ('operator_account_membership_versions', array['organization_id','user_id']::text[], true, null::text)
  ), index_controls as (
    select bool_and(exists(select 1 from pg_catalog.pg_index i
      where i.indrelid = pg_catalog.to_regclass('public.' || r.table_name)
        and i.indisunique and i.indisvalid and i.indisready and i.indimmediate and i.indisprimary = r.is_primary
        and i.indexprs is null and i.indnatts = i.indnkeyatts
        and pg_catalog.pg_get_expr(i.indpred, i.indrelid, false) is not distinct from r.predicate
        and array(select a.attname::text from pg_catalog.unnest(i.indkey) with ordinality k(num, position)
          join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.num order by k.position) = r.keys
    )) as valid from required_indexes r
  ), required_routines(signature, body_hash, volatility, language_name, result_type, argument_names, config, service_execute) as (
    values
      ('public.fireafter_track_account_membership()', '54ee713a1d4642b1658a1facd51faf1dfc58385b9696662644beaa982db8beba', 'v', 'plpgsql', 'trigger', null::text[], array['search_path=""']::text[], false),
      ('public.fireafter_get_account_issuance(uuid)', '97afc10e723eab7730971c3c2bc4e5790786e48472dbdc8546ee64c69b516efa', 's', 'sql', 'jsonb', array['p_attempt_id']::text[], array['search_path=""']::text[], true),
      ('public.fireafter_begin_account_issuance(uuid,text,uuid,text,text,text,uuid)', 'e2ac1aff96381ad36ba0a2cda98cd8b68aae6d7e67f33edc194c8fb3a5966d3a', 'v', 'plpgsql', 'jsonb', array['p_attempt_id','p_email','p_organization_id','p_organization_name','p_requested_role','p_operator_identity','p_existing_user_id']::text[], array['search_path=""','lock_timeout=2s','statement_timeout=20s']::text[], true),
      ('public.fireafter_advance_account_issuance(uuid,uuid,text)', '7216e12364cb7b1463f406b013240fd375f9c18764561d6b0eb60e8d03d6a76c', 'v', 'plpgsql', 'jsonb', array['p_attempt_id','p_user_id','p_phase']::text[], array['search_path=""','lock_timeout=2s','statement_timeout=20s']::text[], true)
  ), routine_controls as (
    select count(*) = 4 and bool_and(coalesce(p.prokind = 'f' and p.prosecdef and not p.proretset
      and not p.proisstrict and not p.proleakproof and p.provolatile::text = r.volatility and p.proparallel = 'u'
      and p.prorettype = pg_catalog.to_regtype('pg_catalog.' || r.result_type)
      and p.pronargdefaults = 0 and p.prosupport = 0 and p.provariadic = 0
      and p.proallargtypes is null and p.proargmodes is null and p.proargnames is not distinct from r.argument_names
      and p.proconfig = r.config and p.proowner = 'postgres'::regrole
      and p.prolang = (select oid from pg_catalog.pg_language where lanname = r.language_name)
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') = r.service_execute
      and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.btrim(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'), E' \t\r\n'), 'UTF8')), 'hex') = r.body_hash
    , false)) as valid from required_routines r join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(r.signature)
  ), trigger_controls as (
    select count(*) = 2
      and not exists(select 1 from pg_catalog.pg_rewrite rw where rw.ev_class = pg_catalog.to_regclass('public.organization_members'))
      and bool_and(coalesce(t.tgenabled = 'A' and not t.tgisinternal
      and t.tgfoid = pg_catalog.to_regprocedure('public.fireafter_track_account_membership()')
      and t.tgnargs = 0 and t.tgqual is null and t.tgattr = ''::pg_catalog.int2vector
      and not t.tgdeferrable and not t.tginitdeferred and t.tgoldtable is null and t.tgnewtable is null
      and ((t.tgname = 'fireafter_account_membership_generation' and t.tgtype = 29)
        or (t.tgname = 'fireafter_account_membership_no_truncate' and t.tgtype = 34))
    , false)) as valid from pg_catalog.pg_trigger t
    where t.tgrelid = pg_catalog.to_regclass('public.organization_members') and not t.tgisinternal
  ), role_controls as (
    select count(*) = 2 and bool_and(coalesce(not r.rolsuper and not r.rolbypassrls and not r.rolcreaterole
      and not r.rolcreatedb and not r.rolreplication and not pg_catalog.pg_has_role(r.oid, 'service_role', 'MEMBER')
      and not pg_catalog.pg_has_role(r.oid, 'postgres', 'MEMBER'), false)) as valid
    from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated')
  ), probe_controls as (
    select count(*) = 1 and bool_and(coalesce(p.proowner = 'postgres'::regrole and not p.prosecdef
      and p.proconfig = array['search_path=""']::text[] and p.provolatile = 's'
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'), false)) as valid
    from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.fireafter_operator_account_issuance_audit_security_version()')
  )
  select case when table_controls.valid and column_controls.valid and check_controls.valid and index_controls.valid
    and routine_controls.valid and trigger_controls.valid and role_controls.valid and probe_controls.valid
    then '20260914150000'::text else null::text end
  from table_controls cross join column_controls cross join check_controls cross join index_controls
    cross join routine_controls cross join trigger_controls cross join role_controls cross join probe_controls;
$$;

alter function public.fireafter_operator_account_issuance_audit_security_version() owner to postgres;
revoke all on function public.fireafter_operator_account_issuance_audit_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_operator_account_issuance_audit_security_version() to service_role;

do $$ begin
  if public.fireafter_operator_account_issuance_audit_security_version() is distinct from '20260914150000' then
    raise exception 'Issuance controls not verified; review catalog, effective grants and pinned coordinator before retrying';
  end if;
end $$;
