set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Allow complete county payloads within a bounded bulk-write budget. No grants,
-- function bodies, row locks, revision fences, or audit controls are widened.
do $$ begin
  if public.fireafter_bundle_persistence_security_version() is distinct from '20260914090000' then
    raise exception 'Bulk-write capacity change requires verified receipt controls';
  end if;
end $$;

alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  set statement_timeout = '30s';
alter function public.fireafter_commit_import(uuid,text,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  set statement_timeout = '30s';

create or replace function public.fireafter_bundle_persistence_security_version()
returns text language sql stable security invoker set search_path = ''
as $$
  with expected(signature, names, settings, body_hash, service_execute) as (
    values
    ('public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
      array['p_actor_id','p_expected_revision','p_operation','p_organization','p_incident',
        'p_source_snapshots','p_assets','p_recommendations','p_responder_actions','p_audit_events']::text[],
      array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      'fe543da2cee605072d697b0747b77b413c97e6108fc0adf0917ff0da967261c2', true),
    ('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
      array['p_organization','p_incident','p_source_snapshots','p_assets','p_recommendations',
        'p_responder_actions','p_audit_events']::text[],
      array['search_path=public']::text[],
      '8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b', false),
    ('public.fireafter_commit_import(uuid,text,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
      array['p_operation_id','p_request_hash','p_actor_id','p_expected_revision','p_operation','p_organization','p_incident','p_source_snapshots','p_assets','p_recommendations','p_responder_actions','p_audit_events']::text[],
      array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      'b3a229f3a69a9f369ad43f19f60f7e8f6b9b8539e7bd74150f8848c607491a7c', true),
    ('public.fireafter_read_import_receipt(uuid,uuid,uuid,uuid)',
      array['p_actor_id','p_organization_id','p_incident_id','p_operation_id']::text[],
      array['search_path=""','lock_timeout=2s','statement_timeout=15s']::text[],
      'f84029027a7fd394eacf3988e11d6851d1254107087630bb82553316fd0e76b1', true)
  ), controls as (
    select count(*) = 4 and pg_catalog.bool_and((
      p.prokind = 'f' and p.prosecdef and not p.proretset
      and not p.proisstrict and not p.proleakproof
      and p.provolatile = 'v' and p.proparallel = 'u'
      and p.prorettype = case when e.signature in ('public.fireafter_read_import_receipt(uuid,uuid,uuid,uuid)',
        'public.fireafter_commit_import(uuid,text,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)')
        then 'pg_catalog.jsonb'::pg_catalog.regtype else 'pg_catalog.void'::pg_catalog.regtype end
      and p.pronargdefaults = 0 and p.prosupport = 0 and p.provariadic = 0
      and p.proallargtypes is null and p.proargmodes is null
      and p.proargnames = e.names and p.proconfig = e.settings
      and p.prolang = (select oid from pg_catalog.pg_language where lanname = 'plpgsql')
      and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      and pg_catalog.has_function_privilege('postgres', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') = e.service_execute
      and not exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl,
          pg_catalog.acldefault('f', p.proowner))) acl
        where acl.privilege_type = 'EXECUTE' and (acl.grantee = 0
          or (acl.grantee <> p.proowner and (not e.service_execute
            or acl.grantee <> (select oid from pg_catalog.pg_roles where rolname = 'service_role')))
          or (acl.grantee <> p.proowner and acl.is_grantable)))
      and (select count(*) = 1 from pg_catalog.pg_proc overload
        where overload.pronamespace = p.pronamespace and overload.proname = p.proname)
      and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.btrim(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'), E' \t\r\n'), 'UTF8')), 'hex') = e.body_hash
    ) is not distinct from true) as verified
    from expected e join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(e.signature)
  )
  select case when controls.verified is not distinct from true
    and exists (select 1 from pg_catalog.pg_class c
      where c.oid = pg_catalog.to_regclass('public.import_operation_receipts')
        and c.relkind = 'r' and c.relrowsecurity and pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
        and not exists (
          select 1 from (values ('anon'), ('authenticated'), ('service_role')) roles(name)
          cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) privileges(name)
          where pg_catalog.has_table_privilege(roles.name, c.oid, privileges.name))
        and not exists (
          select 1 from pg_catalog.pg_attribute a
          cross join (values ('anon'), ('authenticated'), ('service_role')) roles(name)
          cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) privileges(name)
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
            and pg_catalog.has_column_privilege(roles.name, c.oid, a.attnum, privileges.name))
        and (select count(*) = 2 from pg_catalog.pg_trigger t
          where t.tgrelid = c.oid and not t.tgisinternal and t.tgenabled = 'A'
            and t.tgfoid = pg_catalog.to_regprocedure('public.fireafter_prevent_append_only_mutation()')
            and ((t.tgname = 'import_operation_receipts_append_only' and t.tgtype = 27)
              or (t.tgname = 'import_operation_receipts_no_truncate' and t.tgtype = 34))))

    and q.prokind = 'f' and not q.prosecdef and not q.proretset
    and not q.proisstrict and not q.proleakproof and q.provolatile = 's' and q.proparallel = 'u'
    and q.prorettype = 'pg_catalog.text'::pg_catalog.regtype
    and q.prolang = (select oid from pg_catalog.pg_language where lanname = 'sql')
    and q.proconfig = array['search_path=""']::text[]
    and pg_catalog.pg_get_userbyid(q.proowner) = 'postgres'
    and not pg_catalog.has_function_privilege('anon', q.oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', q.oid, 'EXECUTE')
    and pg_catalog.has_function_privilege('service_role', q.oid, 'EXECUTE')
    and not exists (select 1 from pg_catalog.aclexplode(coalesce(q.proacl,
        pg_catalog.acldefault('f', q.proowner))) acl
      where acl.privilege_type = 'EXECUTE' and (acl.grantee = 0
        or acl.grantee not in (q.proowner, (select oid from pg_catalog.pg_roles where rolname = 'service_role'))
        or (acl.grantee <> q.proowner and acl.is_grantable)))
    then '20261002010000'::text else null::text end
  from controls cross join pg_catalog.pg_proc q
  where q.oid = pg_catalog.to_regprocedure('public.fireafter_bundle_persistence_security_version()');
$$;
alter function public.fireafter_bundle_persistence_security_version() owner to postgres;
revoke all on function public.fireafter_bundle_persistence_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_bundle_persistence_security_version() to service_role;

do $$ begin
  if public.fireafter_bundle_persistence_security_version() is distinct from '20261002010000' then
    raise exception 'Bundle fencing attestation failed; reconcile reviewed source, owner, configuration and effective grants';
  end if;
end $$;
notify pgrst, 'reload schema';
