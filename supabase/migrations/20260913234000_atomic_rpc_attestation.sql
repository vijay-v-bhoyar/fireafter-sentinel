set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Fixed expected bodies come from the reviewed historical migrations, never
-- from sampling the current database. This does not close FA-10 command semantics.
-- Only CRLF and outer ASCII whitespace are normalized; internal text is hashed.

create or replace function public.fireafter_responder_action_security_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case when
    p.prokind = 'f' and p.prosecdef and not p.proretset
    and not p.proisstrict and not p.proleakproof
    and p.provolatile = 'v' and p.proparallel = 'u'
    and p.prorettype = 'pg_catalog.void'::pg_catalog.regtype
    and p.pronargdefaults = 0 and p.prosupport = 0
    and p.provariadic = 0 and p.proallargtypes is null and p.proargmodes is null
    and p.proargnames = array['p_action', 'p_audit_event']::text[]
    and p.prolang = (select oid from pg_catalog.pg_language where lanname = 'plpgsql')
    and p.proconfig = array['search_path=public']::text[]
    and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
    and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.fireafter_responder_action_security_version()', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.fireafter_responder_action_security_version()', 'EXECUTE')
    and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.btrim(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'), E' \t\r\n'), 'UTF8')), 'hex')
      = '8011fd1cb4a16fe7ee059ff7d80161c13fe4192aa0d7b6552b122292131a2075'
    then '20260913234000'::text else null::text end
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.fireafter_record_responder_action(jsonb,jsonb)');
$$;

revoke all on function public.fireafter_responder_action_security_version() from public, anon, authenticated;
grant execute on function public.fireafter_responder_action_security_version() to service_role;

create or replace function public.fireafter_bundle_persistence_security_version()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case when
    p.prokind = 'f' and p.prosecdef and not p.proretset
    and not p.proisstrict and not p.proleakproof
    and p.provolatile = 'v' and p.proparallel = 'u'
    and p.prorettype = 'pg_catalog.void'::pg_catalog.regtype
    and p.pronargdefaults = 0 and p.prosupport = 0
    and p.provariadic = 0 and p.proallargtypes is null and p.proargmodes is null
    and p.proargnames = array['p_organization', 'p_incident', 'p_source_snapshots', 'p_assets', 'p_recommendations', 'p_responder_actions', 'p_audit_events']::text[]
    and p.prolang = (select oid from pg_catalog.pg_language where lanname = 'plpgsql')
    and p.proconfig = array['search_path=public']::text[]
    and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
    and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.fireafter_bundle_persistence_security_version()', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.fireafter_bundle_persistence_security_version()', 'EXECUTE')
    and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.btrim(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'), E' \t\r\n'), 'UTF8')), 'hex')
      = '8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b'
    then '20260913234000'::text else null::text end
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)');
$$;

revoke all on function public.fireafter_bundle_persistence_security_version() from public, anon, authenticated;
grant execute on function public.fireafter_bundle_persistence_security_version() to service_role;

-- Existing unexpected owner/body/config or inherited permissions must be reviewed,
-- not silently adopted or repaired by granting broader authority.
do $$
begin
  if public.fireafter_responder_action_security_version() is distinct from '20260913234000'
    or public.fireafter_bundle_persistence_security_version() is distinct from '20260913234000' then
    raise exception 'Atomic RPC attestation failed; reconcile approved bodies, owners, configuration and effective grants before retrying';
  end if;
end;
$$;
