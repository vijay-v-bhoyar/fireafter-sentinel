set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Local candidate only; requires the populated rehearsal in the matching PLAN.
-- Receipt retention is intentional. Deletion/compensation needs operator policy.
create table public.import_operation_receipts (
  actor_id uuid not null references auth.users(id) on delete restrict,
  operation_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  incident_id uuid not null references public.incidents(id) on delete restrict,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  audit_event_id uuid not null unique references public.audit_events(id) on delete restrict,
  revision uuid not null,
  asset_count integer not null check (asset_count between 1 and 100000),
  committed_at timestamptz not null default clock_timestamp(),
  primary key (actor_id, operation_id)
);
alter table public.import_operation_receipts owner to postgres;
alter table public.import_operation_receipts enable row level security;
revoke all on table public.import_operation_receipts from public, anon, authenticated, service_role;
create trigger import_operation_receipts_append_only
before update or delete on public.import_operation_receipts
for each row execute function public.fireafter_prevent_append_only_mutation();
create trigger import_operation_receipts_no_truncate
before truncate on public.import_operation_receipts
for each statement execute function public.fireafter_prevent_append_only_mutation();
alter table public.import_operation_receipts enable always trigger import_operation_receipts_append_only;
alter table public.import_operation_receipts enable always trigger import_operation_receipts_no_truncate;

create function public.fireafter_read_import_receipt(
  p_actor_id uuid, p_organization_id uuid, p_incident_id uuid, p_operation_id uuid
)
returns jsonb language plpgsql volatile security definer called on null input parallel unsafe
set search_path = '' set lock_timeout = '2s' set statement_timeout = '15s'
as $$
declare
  v_receipt public.import_operation_receipts%rowtype;
  v_role text;
  v_organization_id uuid;
begin
  if p_actor_id is null or p_organization_id is null or p_incident_id is null or p_operation_id is null then
    raise exception 'Receipt identities are required' using errcode = 'FB400';
  end if;
  select role into v_role from public.organization_members
    where organization_id = p_organization_id and user_id = p_actor_id for share;
  if not found or (v_role = any(array['analyst', 'incident_commander'])) is distinct from true then
    raise exception 'Current receipt authority is required' using errcode = 'FB401';
  end if;
  select organization_id into v_organization_id from public.incidents
    where id = p_incident_id for share;
  if not found or v_organization_id is distinct from p_organization_id then
    raise exception 'Current incident authority is required' using errcode = 'FB401';
  end if;
  select * into v_receipt from public.import_operation_receipts
    where actor_id = p_actor_id and operation_id = p_operation_id;
  if not found then
    -- A missing committed receipt cannot prove an in-flight request rolled back.
    return null;
  end if;
  if v_receipt.organization_id is distinct from p_organization_id or v_receipt.incident_id is distinct from p_incident_id then
    raise exception 'Operation reference has a different scope' using errcode = 'FB408';
  end if;
  return pg_catalog.jsonb_build_object(
    'operationId', v_receipt.operation_id, 'incidentId', v_receipt.incident_id,
    'requestHash', v_receipt.request_hash, 'auditEventId', v_receipt.audit_event_id,
    'revision', v_receipt.revision, 'assetCount', v_receipt.asset_count, 'committedAt', v_receipt.committed_at);
end;
$$;
alter function public.fireafter_read_import_receipt(uuid,uuid,uuid,uuid) owner to postgres;
revoke all on function public.fireafter_read_import_receipt(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.fireafter_read_import_receipt(uuid,uuid,uuid,uuid) to service_role;

create function public.fireafter_commit_import(
  p_operation_id uuid, p_request_hash text,
  p_actor_id uuid, p_expected_revision uuid, p_operation text,
  p_organization jsonb, p_incident jsonb, p_source_snapshots jsonb, p_assets jsonb,
  p_recommendations jsonb, p_responder_actions jsonb, p_audit_events jsonb
)
returns jsonb language plpgsql volatile security definer called on null input parallel unsafe
set search_path = '' set lock_timeout = '2s' set statement_timeout = '15s'
as $$
declare
  v_receipt jsonb;
  v_incident_id uuid;
  v_organization_id uuid;
  v_asset_count integer;
begin
  if p_operation_id is null or p_actor_id is null or p_operation is distinct from 'import'
    or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_incident) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_organization) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_audit_events) is distinct from 'array' then
    raise exception 'Import operation context is invalid' using errcode = 'FB400';
  end if;
  v_incident_id := (p_incident->>'id')::uuid;
  v_organization_id := (p_organization->>'id')::uuid;
  -- Serialize exact actor/operation replays before touching membership or bundle
  -- locks. Hash collisions only add contention; row identities remain exact.
  perform pg_catalog.pg_advisory_xact_lock(90000, pg_catalog.hashtext(p_actor_id::text || ':' || p_operation_id::text));
  -- Do not take the lookup's incident share lock before the bundle update:
  -- two new imports would otherwise both need to upgrade that shared lock.
  if exists (select 1 from public.import_operation_receipts where actor_id = p_actor_id and operation_id = p_operation_id) then
    v_receipt := public.fireafter_read_import_receipt(p_actor_id, v_organization_id, v_incident_id, p_operation_id);
    if v_receipt->>'requestHash' is distinct from p_request_hash then
      raise exception 'Operation reference has different input' using errcode = 'FB408';
    end if;
    return v_receipt;
  end if;
  if pg_catalog.jsonb_array_length(p_audit_events) <> 1
    or p_audit_events->0->>'event_type' is distinct from 'AssetsImported'
    or pg_catalog.jsonb_typeof(p_audit_events->0->'payload'->'assetCount') is distinct from 'number'
    or p_recommendations is distinct from '[]'::jsonb then
    raise exception 'Import requires one audit and retired rankings' using errcode = 'FB400';
  end if;
  v_asset_count := (p_audit_events->0->'payload'->>'assetCount')::integer;
  if v_asset_count < 1 or v_asset_count > 100000 then
    raise exception 'Import count is invalid' using errcode = 'FB400';
  end if;
  perform public.fireafter_commit_bundle(p_actor_id, p_expected_revision, p_operation,
    p_organization, p_incident, p_source_snapshots, p_assets, p_recommendations, p_responder_actions, p_audit_events);
  -- Failure here rolls back the bundle helper and audit too. Never swallow a
  -- conflict or return a receipt before both writes have committed together.
  insert into public.import_operation_receipts(actor_id, operation_id, organization_id, incident_id,
    request_hash, audit_event_id, revision, asset_count)
  values (p_actor_id, p_operation_id, v_organization_id, v_incident_id, p_request_hash,
    (p_audit_events->0->>'id')::uuid, (p_incident->'selected_fire'->'inventoryManifest'->>'revision')::uuid, v_asset_count);
  return public.fireafter_read_import_receipt(p_actor_id, v_organization_id, v_incident_id, p_operation_id);
exception when data_exception or integrity_constraint_violation then
  raise exception 'Invalid import operation fields or receipt conflict' using errcode = 'FB400';
end;
$$;
alter function public.fireafter_commit_import(uuid,text,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to postgres;
revoke all on function public.fireafter_commit_import(uuid,text,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.fireafter_commit_import(uuid,text,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;

-- Current bundle readiness includes the receipt wrapper, lookup and effective table controls.
create or replace function public.fireafter_bundle_persistence_security_version()
returns text language sql stable security invoker set search_path = ''
as $$
  with expected(signature, names, settings, body_hash, service_execute) as (
    values
    ('public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
      array['p_actor_id','p_expected_revision','p_operation','p_organization','p_incident',
        'p_source_snapshots','p_assets','p_recommendations','p_responder_actions','p_audit_events']::text[],
      array['search_path=""','lock_timeout=2s','statement_timeout=15s']::text[],
      'fe543da2cee605072d697b0747b77b413c97e6108fc0adf0917ff0da967261c2', true),
    ('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
      array['p_organization','p_incident','p_source_snapshots','p_assets','p_recommendations',
        'p_responder_actions','p_audit_events']::text[],
      array['search_path=public']::text[],
      '8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b', false),
    ('public.fireafter_commit_import(uuid,text,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)',
      array['p_operation_id','p_request_hash','p_actor_id','p_expected_revision','p_operation','p_organization','p_incident','p_source_snapshots','p_assets','p_recommendations','p_responder_actions','p_audit_events']::text[],
      array['search_path=""','lock_timeout=2s','statement_timeout=15s']::text[],
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
    then '20260914090000'::text else null::text end
  from controls cross join pg_catalog.pg_proc q
  where q.oid = pg_catalog.to_regprocedure('public.fireafter_bundle_persistence_security_version()');
$$;
alter function public.fireafter_bundle_persistence_security_version() owner to postgres;
revoke all on function public.fireafter_bundle_persistence_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_bundle_persistence_security_version() to service_role;

do $$ begin
  if public.fireafter_bundle_persistence_security_version() is distinct from '20260914090000' then
    raise exception 'Bundle fencing attestation failed; reconcile reviewed source, owner, configuration and effective grants';
  end if;
end $$;
