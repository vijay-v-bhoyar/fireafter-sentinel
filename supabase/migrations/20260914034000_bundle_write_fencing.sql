set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Candidate only: execute as one transaction after the operator gates in PLAN.md.
-- No historical data or helper body is rewritten by this migration.
create function public.fireafter_commit_bundle(
  p_actor_id uuid,
  p_expected_revision uuid,
  p_operation text,
  p_organization jsonb,
  p_incident jsonb,
  p_source_snapshots jsonb,
  p_assets jsonb,
  p_recommendations jsonb,
  p_responder_actions jsonb,
  p_audit_events jsonb
)
returns void
language plpgsql
volatile
security definer
called on null input
parallel unsafe
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '15s'
as $$
declare
  v_incident_id uuid;
  v_organization_id uuid;
  v_organization_name text;
  v_incident public.incidents%rowtype;
  v_role text;
  v_current_revision uuid;
  v_new_revision uuid;
  v_manifest jsonb;
  v_new_manifest jsonb;
  v_key text;
  v_rows jsonb;
  v_row jsonb;
  v_events text[];
  v_audits jsonb := '[]'::jsonb;
  v_actor jsonb := coalesce(pg_catalog.to_jsonb(p_actor_id::text), 'null'::jsonb);
  v_stripe integer;
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if p_operation is null or p_operation not in ('create', 'refresh', 'import', 'fire_context', 'cron_refresh') then
    raise exception 'Invalid bundle operation' using errcode = 'FB400';
  end if;
  if (p_operation = 'cron_refresh' and p_actor_id is not null)
    or (p_operation <> 'cron_refresh' and p_actor_id is null) then
    raise exception 'Current bundle authority is required' using errcode = 'FB401';
  end if;
  if pg_catalog.jsonb_typeof(p_organization) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_incident) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_source_snapshots) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_assets) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_recommendations) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_responder_actions) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_audit_events) is distinct from 'array' then
    raise exception 'Invalid bundle JSON shapes' using errcode = 'FB400';
  end if;
  if p_responder_actions is distinct from '[]'::jsonb then
    raise exception 'Responder decisions require the command RPC' using errcode = 'FB400';
  end if;
  if pg_catalog.jsonb_typeof(p_organization->'id') is distinct from 'string'
    or coalesce(p_organization->>'id', '') !~* v_uuid_pattern
    or pg_catalog.jsonb_typeof(p_incident->'id') is distinct from 'string'
    or coalesce(p_incident->>'id', '') !~* v_uuid_pattern
    or pg_catalog.jsonb_typeof(p_incident->'organization_id') is distinct from 'string'
    or coalesce(p_incident->>'organization_id', '') !~* v_uuid_pattern
    or pg_catalog.jsonb_typeof(p_organization->'name') is distinct from 'string'
    or coalesce(pg_catalog.length(pg_catalog.btrim(p_organization->>'name')), 0) = 0 then
    raise exception 'Invalid bundle identities' using errcode = 'FB400';
  end if;
  v_incident_id := (p_incident->>'id')::uuid;
  v_organization_id := (p_organization->>'id')::uuid;
  if (p_incident->>'organization_id')::uuid is distinct from v_organization_id then
    raise exception 'Bundle organization identities differ' using errcode = 'FB400';
  end if;

  -- The trusted cron route alone chooses null actor. A service key is not a user
  -- identity and remains high privilege; this RPC does not authenticate cron.
  if p_operation <> 'cron_refresh' then
    select role into v_role from public.organization_members
      where organization_id = v_organization_id and user_id = p_actor_id for share;
    if not found or (v_role = any(array['analyst', 'incident_commander'])) is distinct from true then
      raise exception 'Current bundle authority is required' using errcode = 'FB401';
    end if;
  end if;
  -- Organizations are operator-issued, never created or renamed by bundle input.
  -- Take the eventual helper update lock now, not FOR SHARE followed by an
  -- upgrade that could deadlock two same-organization bundle writers.
  select name into v_organization_name from public.organizations
    where id = v_organization_id for no key update;
  if not found then
    raise exception 'Organization no longer exists' using errcode = 'FB404';
  end if;
  -- Membership precedes incident/children, as in fireafter_record_responder_command.
  -- The separate two-int namespace cannot collide with its bigint command lock.
  perform pg_catalog.pg_advisory_xact_lock(34000, pg_catalog.hashtext(v_incident_id::text));
  select * into v_incident from public.incidents where id = v_incident_id for update;
  if found then
    if v_incident.organization_id is distinct from v_organization_id then
      raise exception 'Current incident authority is required' using errcode = 'FB401';
    end if;
    if p_operation = 'create' then
      raise exception 'Incident already exists' using errcode = 'FB409';
    end if;
    if pg_catalog.jsonb_typeof(v_incident.selected_fire) is distinct from 'object' then
      raise exception 'Stored inventory is invalid' using errcode = 'FB400';
    end if;
    -- Only an absent key is legacy. JSON null, missing revision and malformed
    -- manifests must never be converted into a fabricated legacy revision.
    if v_incident.selected_fire ? 'inventoryManifest' then
      v_manifest := v_incident.selected_fire->'inventoryManifest';
      if pg_catalog.jsonb_typeof(v_manifest) is distinct from 'object'
        or v_manifest->>'version' is distinct from '2026-09-13-inventory-v1'
        or pg_catalog.jsonb_typeof(v_manifest->'revision') is distinct from 'string'
        or coalesce(v_manifest->>'revision', '') !~* v_uuid_pattern then
        raise exception 'Stored inventory is invalid' using errcode = 'FB400';
      end if;
      foreach v_key in array array['assetIds', 'recommendationIds', 'sourceSnapshotIds'] loop
        if pg_catalog.jsonb_typeof(v_manifest->v_key) is distinct from 'array' then
          raise exception 'Stored inventory membership is invalid' using errcode = 'FB400';
        end if;
        if pg_catalog.jsonb_array_length(v_manifest->v_key) > 100000
          or exists (select 1 from pg_catalog.jsonb_array_elements(v_manifest->v_key) e(value)
            where pg_catalog.jsonb_typeof(value) is distinct from 'string'
              or coalesce(value #>> '{}', '') !~* v_uuid_pattern)
          or (select count(*) is distinct from count(distinct pg_catalog.lower(value))
            from pg_catalog.jsonb_array_elements_text(v_manifest->v_key) e(value)) then
          raise exception 'Stored inventory membership is invalid' using errcode = 'FB400';
        end if;
      end loop;
      v_current_revision := (v_manifest->>'revision')::uuid;
    end if;
    if p_expected_revision is distinct from v_current_revision then
      raise exception 'Incident revision changed; reload before retrying' using errcode = 'FB409';
    end if;
  else
    if p_operation <> 'create' then
      raise exception 'Incident no longer exists' using errcode = 'FB404';
    end if;
    if p_expected_revision is not null then
      raise exception 'New incident cannot have an expected revision' using errcode = 'FB400';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_incident->'selected_fire') is distinct from 'object' then
    raise exception 'New inventory is required' using errcode = 'FB400';
  end if;
  v_new_manifest := p_incident->'selected_fire'->'inventoryManifest';
  if pg_catalog.jsonb_typeof(v_new_manifest) is distinct from 'object'
    or v_new_manifest->>'version' is distinct from '2026-09-13-inventory-v1'
    or pg_catalog.jsonb_typeof(v_new_manifest->'revision') is distinct from 'string'
    or coalesce(v_new_manifest->>'revision', '') !~* v_uuid_pattern then
    raise exception 'New inventory is invalid' using errcode = 'FB400';
  end if;
  v_new_revision := (v_new_manifest->>'revision')::uuid;
  if v_new_revision is not distinct from v_current_revision then
    raise exception 'Bundle must advance the inventory revision' using errcode = 'FB400';
  end if;
  foreach v_key in array array['assetIds', 'recommendationIds', 'sourceSnapshotIds'] loop
    v_rows := case v_key when 'assetIds' then p_assets
      when 'recommendationIds' then p_recommendations else p_source_snapshots end;
    if pg_catalog.jsonb_typeof(v_new_manifest->v_key) is distinct from 'array' then
      raise exception 'New inventory membership is invalid' using errcode = 'FB400';
    end if;
    if pg_catalog.jsonb_array_length(v_new_manifest->v_key) > 100000
      or pg_catalog.jsonb_array_length(v_rows) > 100000
      or exists (select 1 from pg_catalog.jsonb_array_elements(v_new_manifest->v_key) e(value)
        where pg_catalog.jsonb_typeof(value) is distinct from 'string'
          or coalesce(value #>> '{}', '') !~* v_uuid_pattern)
      or (select count(*) is distinct from count(distinct pg_catalog.lower(value))
        from pg_catalog.jsonb_array_elements_text(v_new_manifest->v_key) e(value)) then
      raise exception 'New inventory identities are invalid' using errcode = 'FB400';
    end if;
    if exists (select 1 from pg_catalog.jsonb_array_elements(v_rows) e(value)
      where pg_catalog.jsonb_typeof(value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(value->'id') is distinct from 'string'
        or coalesce(value->>'id', '') !~* v_uuid_pattern
        or pg_catalog.jsonb_typeof(value->'incident_id') is distinct from 'string'
        or pg_catalog.lower(value->>'incident_id') is distinct from v_incident_id::text)
      or (select count(*) is distinct from count(distinct pg_catalog.lower(value->>'id'))
        from pg_catalog.jsonb_array_elements(v_rows) e(value)) then
      raise exception 'Bundle child identities are invalid' using errcode = 'FB400';
    end if;
    if (select pg_catalog.array_agg(pg_catalog.lower(value) order by pg_catalog.lower(value))
        from pg_catalog.jsonb_array_elements_text(v_new_manifest->v_key) e(value))
      is distinct from
      (select pg_catalog.array_agg(pg_catalog.lower(value->>'id') order by pg_catalog.lower(value->>'id'))
        from pg_catalog.jsonb_array_elements(v_rows) e(value)) then
      raise exception 'Manifest does not exactly match bundle rows' using errcode = 'FB400';
    end if;
  end loop;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_recommendations) r(value)
    where pg_catalog.jsonb_typeof(value->'asset_id') is distinct from 'string'
      or not exists (select 1 from pg_catalog.jsonb_array_elements_text(v_new_manifest->'assetIds') a(id)
        where pg_catalog.lower(a.id) = pg_catalog.lower(r.value->>'asset_id'))) then
    raise exception 'Recommendation asset is outside the new inventory' using errcode = 'FB400';
  end if;

  v_events := case p_operation
    when 'create' then array['IncidentCreated', 'SourcesRefreshed']
    when 'import' then array['AssetsImported']
    when 'fire_context' then array['FireContextSelected']
    else array['SourcesRefreshed'] end;
  if pg_catalog.jsonb_array_length(p_audit_events) is distinct from pg_catalog.cardinality(v_events) then
    raise exception 'Exact operation audit events are required' using errcode = 'FB400';
  end if;
  if (select pg_catalog.array_agg(value->>'event_type' order by value->>'event_type')
      from pg_catalog.jsonb_array_elements(p_audit_events) e(value)) is distinct from v_events then
    raise exception 'Audit events do not match the bundle operation' using errcode = 'FB400';
  end if;
  for v_row in select value from pg_catalog.jsonb_array_elements(p_audit_events) e(value) loop
    if pg_catalog.jsonb_typeof(v_row) is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_row->'id') is distinct from 'string'
      or coalesce(v_row->>'id', '') !~* v_uuid_pattern
      or pg_catalog.lower(v_row->>'incident_id') is distinct from v_incident_id::text
      or v_row->'recommendation_id' is distinct from 'null'::jsonb
      or v_row->'actor_id' is distinct from v_actor
      or pg_catalog.jsonb_typeof(v_row->'payload') is distinct from 'object'
      or v_row->'payload'->'actorId' is distinct from v_actor
      or v_row->'payload'->'operation' is distinct from pg_catalog.to_jsonb(p_operation)
      or v_row->'payload'->'expectedRevision' is distinct from
        coalesce(pg_catalog.to_jsonb(p_expected_revision::text), 'null'::jsonb)
      or pg_catalog.jsonb_typeof(v_row->'actor_name') is distinct from 'string'
      or coalesce(pg_catalog.length(pg_catalog.btrim(v_row->>'actor_name')), 0) = 0
      or pg_catalog.jsonb_typeof(v_row->'summary') is distinct from 'string'
      or coalesce(pg_catalog.length(pg_catalog.btrim(v_row->>'summary')), 0) = 0
      or pg_catalog.jsonb_typeof(v_row->'created_at') is distinct from 'string' then
      raise exception 'Audit identity or actor does not match the operation' using errcode = 'FB400';
    end if;
    if (pg_catalog.isfinite((v_row->>'created_at')::timestamptz)) is distinct from true then
      raise exception 'Audit timestamp is invalid' using errcode = 'FB400';
    end if;
    v_audits := v_audits || pg_catalog.jsonb_build_array(v_row || pg_catalog.jsonb_build_object(
      'actor_id', p_actor_id, 'payload', (v_row->'payload') || pg_catalog.jsonb_build_object('actorId', p_actor_id)));
  end loop;
  if (select count(*) is distinct from count(distinct pg_catalog.lower(value->>'id'))
    from pg_catalog.jsonb_array_elements(v_audits) e(value)) then
    raise exception 'Audit identities must be unique' using errcode = 'FB400';
  end if;

  -- The historical helper upserts globally keyed children. Bounded, sorted
  -- advisory stripes fence absent-ID collisions across different incidents too.
  -- Hash collisions add contention only; exact parent checks remain mandatory.
  for v_stripe in
    select distinct (pg_catalog.hashtext(pg_catalog.lower(value->>'id')) & 63) as stripe
    from pg_catalog.jsonb_array_elements(p_assets || p_recommendations || p_source_snapshots || v_audits) e(value)
    order by stripe
  loop
    perform pg_catalog.pg_advisory_xact_lock(34001, v_stripe);
  end loop;
  if exists (select 1 from public.assets a
      join pg_catalog.jsonb_array_elements(p_assets) e(value) on a.id = (value->>'id')::uuid
      where a.incident_id is distinct from v_incident_id)
    or exists (select 1 from public.recommendations r
      join pg_catalog.jsonb_array_elements(p_recommendations) e(value) on r.id = (value->>'id')::uuid
      where r.incident_id is distinct from v_incident_id)
    or exists (select 1 from public.source_snapshots s
      join pg_catalog.jsonb_array_elements(p_source_snapshots) e(value) on s.id = (value->>'id')::uuid
      where s.incident_id is distinct from v_incident_id) then
    raise exception 'Bundle cannot move another incident child' using errcode = 'FB400';
  end if;
  if exists (select 1 from public.audit_events a
    join pg_catalog.jsonb_array_elements(v_audits) e(value) on a.id = (value->>'id')::uuid) then
    raise exception 'Bundle audit identity already exists' using errcode = 'FB400';
  end if;

  perform public.fireafter_persist_bundle(
    pg_catalog.jsonb_build_object('id', v_organization_id, 'name', v_organization_name), p_incident, p_source_snapshots,
    p_assets, p_recommendations, '[]'::jsonb, v_audits);
  -- ON CONFLICT DO NOTHING in the old helper must not turn a late collision into
  -- an unaudited success (including a collision with the separate action RPC).
  if exists (select 1 from pg_catalog.jsonb_to_recordset(v_audits) e(
      id uuid, incident_id uuid, recommendation_id uuid, actor_id uuid, actor_name text,
      event_type text, summary text, payload jsonb, created_at timestamptz)
    left join public.audit_events a on a.id = e.id
    where a.id is null or a.incident_id is distinct from e.incident_id
      or a.recommendation_id is distinct from e.recommendation_id
      or a.actor_id is distinct from e.actor_id or a.actor_name is distinct from e.actor_name
      or a.event_type is distinct from e.event_type or a.summary is distinct from e.summary
      or a.payload is distinct from e.payload or a.created_at is distinct from e.created_at) then
    raise exception 'Bundle audit was not committed as authorized' using errcode = 'FB400';
  end if;
exception when data_exception or integrity_constraint_violation then
  -- The entire helper call rolls back too, including late child/audit failures.
  raise exception 'Invalid bundle fields or conflicting row identities' using errcode = 'FB400';
end;
$$;

alter function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) owner to postgres;
revoke all on function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;
revoke all on function public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;

-- Fixed source hashes come from reviewed files, never sampled target definitions.
-- Transitive triggers/tables and service-key custody require their separate gates.
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
      '8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b', false)
  ), controls as (
    select count(*) = 2 and pg_catalog.bool_and((
      p.prokind = 'f' and p.prosecdef and not p.proretset
      and not p.proisstrict and not p.proleakproof
      and p.provolatile = 'v' and p.proparallel = 'u'
      and p.prorettype = 'pg_catalog.void'::pg_catalog.regtype
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
    then '20260914034000'::text else null::text end
  from controls cross join pg_catalog.pg_proc q
  where q.oid = pg_catalog.to_regprocedure('public.fireafter_bundle_persistence_security_version()');
$$;
alter function public.fireafter_bundle_persistence_security_version() owner to postgres;
revoke all on function public.fireafter_bundle_persistence_security_version() from public, anon, authenticated, service_role;
grant execute on function public.fireafter_bundle_persistence_security_version() to service_role;

do $$ begin
  if public.fireafter_bundle_persistence_security_version() is distinct from '20260914034000' then
    raise exception 'Bundle fencing attestation failed; reconcile reviewed source, owner, configuration and effective grants';
  end if;
end $$;
