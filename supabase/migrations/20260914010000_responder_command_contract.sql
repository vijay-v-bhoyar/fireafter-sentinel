set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- New objects intentionally have no IF NOT EXISTS: unknown prior state is not adopted.
-- Retention is explicit: receipts must survive retries and cannot be cascaded away.
create table public.responder_command_receipts (
  actor_id uuid not null references auth.users(id) on delete restrict,
  command_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  incident_id uuid not null references public.incidents(id) on delete restrict,
  expected_revision uuid not null,
  request jsonb not null check (jsonb_typeof(request) = 'object'),
  response jsonb not null check (jsonb_typeof(response) = 'object'
    and response ?& array['action', 'auditEvent']),
  created_at timestamptz not null default now(),
  primary key (actor_id, command_id)
);
alter table public.responder_command_receipts owner to postgres;
alter table public.responder_command_receipts enable row level security;
revoke all on table public.responder_command_receipts from public, anon, authenticated, service_role;
grant select on table public.responder_command_receipts to service_role;

create trigger responder_command_receipts_append_only
before update or delete on public.responder_command_receipts
for each row execute function public.fireafter_prevent_append_only_mutation();
create trigger responder_command_receipts_no_truncate
before truncate on public.responder_command_receipts
for each statement execute function public.fireafter_prevent_append_only_mutation();
alter table public.responder_command_receipts enable always trigger responder_command_receipts_append_only;
alter table public.responder_command_receipts enable always trigger responder_command_receipts_no_truncate;

create function public.fireafter_record_responder_command(
  p_command_id uuid,
  p_actor_id uuid,
  p_organization_id uuid,
  p_expected_revision uuid,
  p_request jsonb,
  p_action jsonb,
  p_audit_event jsonb
)
returns jsonb
language plpgsql
volatile
security definer
called on null input
parallel unsafe
-- Caller/role statement_timeout must also be bounded before starting the request;
-- a function-local setting does not restart the enclosing statement's timer.
set search_path = public
set lock_timeout = '2s'
set statement_timeout = '15s'
as $$
declare
  v_recommendation_id uuid;
  v_incident_id uuid;
  v_role text;
  v_incident public.incidents%rowtype;
  v_recommendation public.recommendations%rowtype;
  v_asset public.assets%rowtype;
  v_receipt public.responder_command_receipts%rowtype;
  v_action public.responder_actions%rowtype;
  v_audit public.audit_events%rowtype;
  v_manifest jsonb;
  v_key text;
  v_event_type text;
  v_snapshot jsonb;
  v_response jsonb;
begin
  if p_command_id is null or p_actor_id is null or p_organization_id is null
    or p_expected_revision is null then
    raise exception 'Command identities are required' using errcode = 'FA422';
  end if;
  if jsonb_typeof(p_request) is distinct from 'object' then
    raise exception 'Command request must be an object' using errcode = 'FA422';
  end if;
  if not (p_request ?& array['recommendationId', 'action', 'note', 'modifiedPriority'])
    or (select count(*) from jsonb_object_keys(p_request)) <> 4
    or jsonb_typeof(p_request->'recommendationId') is distinct from 'string'
    or jsonb_typeof(p_request->'action') is distinct from 'string'
    or jsonb_typeof(p_request->'note') is distinct from 'string'
    or jsonb_typeof(p_request->'modifiedPriority') not in ('string', 'null')
    or (p_request->>'action') not in ('accept', 'modify', 'reject', 'annotate')
    or length(p_request->>'note') > 2000
    or ((p_request->>'modifiedPriority') is not null
      and (p_request->>'modifiedPriority') not in ('Very High', 'High', 'Medium', 'Low', 'Very Low'))
    or ((p_request->>'action') = 'modify' and
      (length(btrim(p_request->>'note', E' \t\r\n')) = 0 or p_request->>'modifiedPriority' is null))
    or ((p_request->>'action') <> 'modify' and p_request->>'modifiedPriority' is not null)
    or ((p_action is null) <> (p_audit_event is null)) then
    raise exception 'Invalid command request or incomplete row pair' using errcode = 'FA422';
  end if;
  begin
    v_recommendation_id := (p_request->>'recommendationId')::uuid;
  exception when invalid_text_representation then
    raise exception 'Invalid recommendation identity' using errcode = 'FA422';
  end;
  if v_recommendation_id is null then
    raise exception 'Recommendation identity is required' using errcode = 'FA422';
  end if;

  -- Hash collisions only serialize unrelated commands; the primary key is exact.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_actor_id::text || ':' || p_command_id::text, 0));
  select role into v_role from public.organization_members
    where organization_id = p_organization_id and user_id = p_actor_id for share;
  if not found or v_role not in ('analyst', 'incident_commander') then
    raise exception 'Current responder authority is required' using errcode = 'FA401';
  end if;

  select * into v_receipt from public.responder_command_receipts
    where actor_id = p_actor_id and command_id = p_command_id;
  if found then
    if v_receipt.organization_id is distinct from p_organization_id
      or v_receipt.expected_revision is distinct from p_expected_revision
      or v_receipt.request is distinct from p_request then
      raise exception 'Command identity was already used for a different request' using errcode = 'FA408';
    end if;
    select * into v_incident from public.incidents where id = v_receipt.incident_id for update;
    if not found or v_incident.organization_id is distinct from p_organization_id then
      raise exception 'Current incident authority is required' using errcode = 'FA401';
    end if;
    return v_receipt.response;
  end if;

  -- This lookup locates the lock only. No mutable recommendation is trusted yet.
  select incident_id into v_incident_id from public.recommendations where id = v_recommendation_id;
  if not found then
    raise exception 'Recommendation is no longer current' using errcode = 'FA409';
  end if;
  select * into v_incident from public.incidents where id = v_incident_id for update;
  if not found or v_incident.organization_id is distinct from p_organization_id then
    raise exception 'Current incident authority is required' using errcode = 'FA401';
  end if;
  -- Bundle persistence takes this incident lock before changing assets/recommendations.
  select * into v_recommendation from public.recommendations
    where id = v_recommendation_id and incident_id = v_incident.id for share;
  if not found then
    raise exception 'Recommendation changed while obtaining the incident lock' using errcode = 'FA409';
  end if;
  select * into v_asset from public.assets
    where id = v_recommendation.asset_id and incident_id = v_incident.id for share;
  if not found then
    raise exception 'Recommendation asset is no longer current' using errcode = 'FA409';
  end if;
  v_manifest := v_incident.selected_fire->'inventoryManifest';
  if jsonb_typeof(v_manifest) is distinct from 'object'
    or v_manifest->>'version' is distinct from '2026-09-13-inventory-v1'
    or coalesce(v_manifest->>'revision', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or lower(v_manifest->>'revision') is distinct from p_expected_revision::text then
    raise exception 'Incident revision is not current' using errcode = 'FA409';
  end if;
  foreach v_key in array array['assetIds', 'recommendationIds', 'sourceSnapshotIds'] loop
    if jsonb_typeof(v_manifest->v_key) is distinct from 'array' then
      raise exception 'Current inventory is invalid' using errcode = 'FA409';
    end if;
    if jsonb_array_length(v_manifest->v_key) > 100000
      or exists (select 1 from jsonb_array_elements(v_manifest->v_key) e(value)
        where jsonb_typeof(value) <> 'string'
          or (value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      or (select count(*) <> count(distinct lower(value))
        from jsonb_array_elements_text(v_manifest->v_key) e(value)) then
      raise exception 'Current inventory identities are invalid' using errcode = 'FA409';
    end if;
  end loop;
  if not exists (select 1 from jsonb_array_elements_text(v_manifest->'recommendationIds') e(value)
      where lower(value) = v_recommendation.id::text)
    or not exists (select 1 from jsonb_array_elements_text(v_manifest->'assetIds') e(value)
      where lower(value) = v_asset.id::text) then
    raise exception 'Recommendation is outside the current inventory' using errcode = 'FA409';
  end if;
  if p_action is null then return null; end if;

  if jsonb_typeof(p_action) is distinct from 'object'
    or jsonb_typeof(p_audit_event) is distinct from 'object' then
    raise exception 'Action and audit must be objects' using errcode = 'FA422';
  end if;
  if not (p_action ?& array['id', 'recommendation_id', 'action', 'note', 'actor_id',
      'actor_name', 'recommendation_snapshot', 'created_at'])
    or not (p_audit_event ?& array['id', 'incident_id', 'recommendation_id', 'actor_id',
      'actor_name', 'event_type', 'summary', 'payload', 'created_at']) then
    raise exception 'Action and audit fields are required' using errcode = 'FA422';
  end if;
  begin
    select * into v_action from jsonb_populate_record(null::public.responder_actions, p_action);
    select * into v_audit from jsonb_populate_record(null::public.audit_events, p_audit_event);
  exception when data_exception then
    raise exception 'Invalid action or audit field encoding' using errcode = 'FA422';
  end;
  v_event_type := case p_request->>'action'
    when 'accept' then 'RecommendationAccepted' when 'modify' then 'RecommendationModified'
    when 'reject' then 'RecommendationRejected' when 'annotate' then 'RecommendationAnnotated' end;
  if jsonb_typeof(v_action.recommendation_snapshot) is distinct from 'object'
    or jsonb_typeof(v_audit.payload) is distinct from 'object' then
    raise exception 'Snapshot and audit payload must be objects' using errcode = 'FA422';
  end if;
  v_snapshot := v_action.recommendation_snapshot - 'domainActionId';
  if v_action.id is null or v_audit.id is null or v_action.id = v_audit.id
    or v_action.actor_id is distinct from p_actor_id or v_audit.actor_id is distinct from p_actor_id
    or v_audit.incident_id is distinct from v_incident.id
    or v_action.recommendation_id is distinct from v_recommendation.id
    or v_audit.recommendation_id is distinct from v_recommendation.id
    or v_action.action is distinct from p_request->>'action'
    or v_action.note is distinct from p_request->>'note'
    or v_action.modified_priority is distinct from p_request->>'modifiedPriority'
    or p_action->'action' is distinct from p_request->'action'
    or p_action->'note' is distinct from p_request->'note'
    or coalesce(p_action->'modified_priority', 'null'::jsonb) is distinct from p_request->'modifiedPriority'
    or jsonb_typeof(p_action->'actor_name') is distinct from 'string'
    or coalesce(length(btrim(v_action.actor_name)), 0) = 0
    or v_audit.actor_name is distinct from v_action.actor_name
    or v_audit.event_type is distinct from v_event_type
    or jsonb_typeof(p_audit_event->'summary') is distinct from 'string'
    or coalesce(length(btrim(v_audit.summary)), 0) = 0
    or jsonb_typeof(p_action->'created_at') is distinct from 'string'
    or jsonb_typeof(p_audit_event->'created_at') is distinct from 'string'
    or v_action.created_at is null or not isfinite(v_action.created_at)
    or v_audit.created_at is distinct from v_action.created_at
    or jsonb_typeof(v_snapshot) is distinct from 'object'
    or v_snapshot->>'id' is distinct from coalesce(v_recommendation.score_breakdown->>'domainRecommendationId', v_recommendation.id::text)
    or v_snapshot->>'incidentId' is distinct from coalesce(v_incident.selected_fire->>'domainIncidentId', v_incident.id::text)
    or v_snapshot->>'assetId' is distinct from coalesce(v_asset.properties->>'domainAssetId', v_asset.id::text)
    or jsonb_typeof(v_audit.payload) is distinct from 'object'
    or v_audit.payload->'recommendationSnapshot' is distinct from v_snapshot
    or v_audit.payload->'action' is distinct from p_request->'action'
    or v_audit.payload->'note' is distinct from p_request->'note'
    or (v_audit.payload ? 'domainIncidentId' and v_audit.payload->>'domainIncidentId'
      is distinct from v_snapshot->>'incidentId')
    or (v_audit.payload ? 'domainRecommendationId' and v_audit.payload->>'domainRecommendationId'
      is distinct from v_snapshot->>'id')
    or v_audit.payload->'commandId' is distinct from to_jsonb(p_command_id::text)
    or v_audit.payload->'expectedRevision' is distinct from to_jsonb(p_expected_revision::text)
    or v_action.recommendation_snapshot->'domainActionId' is distinct from
      to_jsonb('action-command-' || p_actor_id::text || '-' || p_command_id::text)
    or v_audit.payload->'domainAuditEventId' is distinct from
      to_jsonb('audit-command-' || p_actor_id::text || '-' || p_command_id::text)
    or coalesce(v_audit.payload->'modifiedPriority', 'null'::jsonb) is distinct from p_request->'modifiedPriority' then
    raise exception 'Action and audit do not match the authorized command' using errcode = 'FA422';
  end if;

  insert into public.responder_actions (id, recommendation_id, action, note, actor_id,
    actor_name, modified_priority, recommendation_snapshot, created_at)
  values (v_action.id, v_action.recommendation_id, v_action.action, v_action.note,
    v_action.actor_id, v_action.actor_name, v_action.modified_priority, v_action.recommendation_snapshot,
    v_action.created_at) returning * into v_action;
  insert into public.audit_events (id, incident_id, recommendation_id, actor_id, actor_name,
    event_type, summary, payload, created_at)
  values (v_audit.id, v_audit.incident_id, v_audit.recommendation_id, v_audit.actor_id,
    v_audit.actor_name, v_audit.event_type, v_audit.summary, v_audit.payload, v_audit.created_at)
  returning * into v_audit;
  v_response := jsonb_build_object('action', to_jsonb(v_action), 'auditEvent', to_jsonb(v_audit));
  insert into public.responder_command_receipts (actor_id, command_id, organization_id,
    incident_id, expected_revision, request, response)
  values (p_actor_id, p_command_id, p_organization_id, v_incident.id, p_expected_revision, p_request, v_response);
  return v_response;
exception when unique_violation or foreign_key_violation or check_violation or not_null_violation then
  -- An exception rolls back both row inserts and the receipt, including late conflicts.
  raise exception 'Command row identities or constraints conflict' using errcode = 'FA422';
end;
$$;
alter function public.fireafter_record_responder_command(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb) owner to postgres;
revoke all on function public.fireafter_record_responder_command(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.fireafter_record_responder_command(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;
revoke all on function public.fireafter_record_responder_action(jsonb,jsonb) from public, anon, authenticated, service_role;

-- The bundle attestation is intentionally unchanged. This is a new action contract.
create or replace function public.fireafter_responder_action_security_version()
returns text language sql stable security invoker set search_path = ''
as $$
  select case when
    p.prokind = 'f' and p.prosecdef and not p.proretset and not p.proisstrict and not p.proleakproof
    and p.provolatile = 'v' and p.proparallel = 'u'
    and p.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
    and p.pronargdefaults = 0 and p.prosupport = 0 and p.provariadic = 0
    and p.proallargtypes is null and p.proargmodes is null
    and p.proargnames = array['p_command_id', 'p_actor_id', 'p_organization_id', 'p_expected_revision', 'p_request', 'p_action', 'p_audit_event']::text[]
    and p.prolang = (select oid from pg_catalog.pg_language where lanname = 'plpgsql')
    and p.proconfig = array['search_path=public', 'lock_timeout=2s', 'statement_timeout=15s']::text[]
    and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
    and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.fireafter_record_responder_action(jsonb,jsonb)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.fireafter_record_responder_action(jsonb,jsonb)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('service_role', 'public.fireafter_record_responder_action(jsonb,jsonb)', 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', 'public.fireafter_responder_action_security_version()', 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', 'public.fireafter_responder_action_security_version()', 'EXECUTE')
    and pg_catalog.has_function_privilege('service_role', 'public.fireafter_responder_action_security_version()', 'EXECUTE')
    and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.btrim(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'), E' \t\r\n'), 'UTF8')), 'hex') = '586ff8b9077f590d8b3f6886bc335888fe5da1cb319fb38970797ba555602bac'
    and c.relrowsecurity and c.relkind = 'r' and pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
    and not pg_catalog.has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
    and not pg_catalog.has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
    and pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')
    and not pg_catalog.has_table_privilege('service_role', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not pg_catalog.has_any_column_privilege('service_role', c.oid, 'INSERT,UPDATE,REFERENCES')
    and (select count(*) = 2 from pg_catalog.pg_trigger t where t.tgrelid = c.oid
      and not t.tgisinternal and t.tgenabled = 'A'
      and t.tgfoid = 'public.fireafter_prevent_append_only_mutation()'::pg_catalog.regprocedure
      and ((t.tgname = 'responder_command_receipts_append_only' and t.tgtype = 27)
        or (t.tgname = 'responder_command_receipts_no_truncate' and t.tgtype = 34)))
    then '20260914010000'::text else null::text end
  from pg_catalog.pg_proc p
  cross join pg_catalog.pg_class c
  where p.oid = pg_catalog.to_regprocedure('public.fireafter_record_responder_command(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb)')
    and c.oid = pg_catalog.to_regclass('public.responder_command_receipts');
$$;
revoke all on function public.fireafter_responder_action_security_version() from public, anon, authenticated;
grant execute on function public.fireafter_responder_action_security_version() to service_role;

do $$ begin
  if public.fireafter_responder_action_security_version() is distinct from '20260914010000' then
    raise exception 'Responder command controls are not verified';
  end if;
end $$;
