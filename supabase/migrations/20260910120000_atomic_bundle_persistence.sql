set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Persist the incident snapshot and its replaceable children in one transaction.
-- The service role is the only caller; route authorization happens before this
-- database boundary and browser roles cannot execute the function.
create or replace function public.fireafter_persist_bundle(
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
security definer
set search_path = public
as $$
declare
  v_incident_id uuid;
  v_organization_id uuid;
begin
  if jsonb_typeof(p_organization) <> 'object'
    or jsonb_typeof(p_incident) <> 'object'
    or jsonb_typeof(coalesce(p_source_snapshots, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_assets, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_recommendations, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_responder_actions, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_audit_events, '[]'::jsonb)) <> 'array'
  then
    raise exception 'FireAfter bundle payload has invalid JSON shapes.'
      using errcode = '22023';
  end if;

  if nullif(p_organization->>'id', '') is null
    or nullif(p_organization->>'name', '') is null
    or nullif(p_incident->>'id', '') is null
    or nullif(p_incident->>'organization_id', '') is null
  then
    raise exception 'FireAfter bundle payload is missing organization or incident identity.'
      using errcode = '22023';
  end if;

  v_organization_id := (p_organization->>'id')::uuid;
  v_incident_id := (p_incident->>'id')::uuid;

  if (p_incident->>'organization_id')::uuid is distinct from v_organization_id then
    raise exception 'FireAfter bundle organization and incident identities must match.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_source_snapshots, '[]'::jsonb)) as row(incident_id uuid)
    where row.incident_id is distinct from v_incident_id
  ) or exists (
    select 1
    from jsonb_to_recordset(coalesce(p_assets, '[]'::jsonb)) as row(incident_id uuid)
    where row.incident_id is distinct from v_incident_id
  ) or exists (
    select 1
    from jsonb_to_recordset(coalesce(p_recommendations, '[]'::jsonb)) as row(incident_id uuid)
    where row.incident_id is distinct from v_incident_id
  ) then
    raise exception 'FireAfter bundle child rows must belong to the same incident.'
      using errcode = '22023';
  end if;

  insert into public.organizations (id, name)
  values (v_organization_id, p_organization->>'name')
  on conflict (id) do update set name = excluded.name;

  insert into public.incidents (
    id,
    organization_id,
    county,
    state,
    title,
    status,
    storm_window,
    selected_fire,
    last_refresh,
    location_context,
    fire_candidates,
    coverage_status
  ) values (
    v_incident_id,
    v_organization_id,
    p_incident->>'county',
    p_incident->>'state',
    p_incident->>'title',
    p_incident->>'status',
    p_incident->>'storm_window',
    coalesce(p_incident->'selected_fire', '{}'::jsonb),
    nullif(p_incident->>'last_refresh', '')::timestamptz,
    p_incident->'location_context',
    coalesce(p_incident->'fire_candidates', '[]'::jsonb),
    coalesce(nullif(p_incident->>'coverage_status', ''), 'not_available')
  )
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    county = excluded.county,
    state = excluded.state,
    title = excluded.title,
    status = excluded.status,
    storm_window = excluded.storm_window,
    selected_fire = excluded.selected_fire,
    last_refresh = excluded.last_refresh,
    location_context = excluded.location_context,
    fire_candidates = excluded.fire_candidates,
    coverage_status = excluded.coverage_status;

  delete from public.source_snapshots where incident_id = v_incident_id;

  insert into public.source_snapshots (
    id,
    incident_id,
    source_key,
    source_url,
    source_name,
    fetched_at,
    source_updated_at,
    status,
    stale,
    freshness_label,
    coverage_status,
    warnings,
    derived_signals,
    raw_payload
  )
  select
    row.id,
    row.incident_id,
    row.source_key,
    row.source_url,
    row.source_name,
    row.fetched_at,
    row.source_updated_at,
    row.status,
    row.stale,
    row.freshness_label,
    coalesce(row.coverage_status, 'not_available'),
    coalesce(row.warnings, '{}'::text[]),
    coalesce(row.derived_signals, '{}'::jsonb),
    coalesce(row.raw_payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_source_snapshots, '[]'::jsonb)) as row(
    id uuid,
    incident_id uuid,
    source_key text,
    source_url text,
    source_name text,
    fetched_at timestamptz,
    source_updated_at timestamptz,
    status text,
    stale boolean,
    freshness_label text,
    coverage_status text,
    warnings text[],
    derived_signals jsonb,
    raw_payload jsonb
  );

  insert into public.assets (
    id,
    incident_id,
    name,
    asset_type,
    location_label,
    source,
    source_key,
    source_url,
    source_feature_id,
    source_feature_ids,
    geometry_geojson,
    origin,
    coverage_status,
    confidence_reason,
    confidence,
    local_or_uploaded,
    properties
  )
  select
    row.id,
    row.incident_id,
    row.name,
    row.asset_type,
    row.location_label,
    row.source,
    row.source_key,
    row.source_url,
    row.source_feature_id,
    coalesce(row.source_feature_ids, '{}'::text[]),
    row.geometry_geojson,
    row.origin,
    coalesce(row.coverage_status, 'not_available'),
    row.confidence_reason,
    row.confidence,
    row.local_or_uploaded,
    coalesce(row.properties, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_assets, '[]'::jsonb)) as row(
    id uuid,
    incident_id uuid,
    name text,
    asset_type text,
    location_label text,
    source text,
    source_key text,
    source_url text,
    source_feature_id text,
    source_feature_ids text[],
    geometry_geojson jsonb,
    origin text,
    coverage_status text,
    confidence_reason text,
    confidence text,
    local_or_uploaded boolean,
    properties jsonb
  )
  on conflict (id) do update set
    incident_id = excluded.incident_id,
    name = excluded.name,
    asset_type = excluded.asset_type,
    location_label = excluded.location_label,
    source = excluded.source,
    source_key = excluded.source_key,
    source_url = excluded.source_url,
    source_feature_id = excluded.source_feature_id,
    source_feature_ids = excluded.source_feature_ids,
    geometry_geojson = excluded.geometry_geojson,
    origin = excluded.origin,
    coverage_status = excluded.coverage_status,
    confidence_reason = excluded.confidence_reason,
    confidence = excluded.confidence,
    local_or_uploaded = excluded.local_or_uploaded,
    properties = excluded.properties;

  insert into public.recommendations (
    id,
    incident_id,
    asset_id,
    final_score,
    score_100,
    risk_level,
    confidence_level,
    recommended_action,
    reason_codes,
    limitations,
    changed_since_last_refresh,
    score_breakdown,
    evidence,
    metric_status,
    source_snapshot_ids
  )
  select
    row.id,
    row.incident_id,
    row.asset_id,
    row.final_score,
    row.score_100,
    row.risk_level,
    row.confidence_level,
    row.recommended_action,
    coalesce(row.reason_codes, '{}'::text[]),
    coalesce(row.limitations, '{}'::text[]),
    row.changed_since_last_refresh,
    row.score_breakdown,
    coalesce(row.evidence, '[]'::jsonb),
    coalesce(row.metric_status, '{}'::jsonb),
    coalesce(row.source_snapshot_ids, '{}'::text[])
  from jsonb_to_recordset(coalesce(p_recommendations, '[]'::jsonb)) as row(
    id uuid,
    incident_id uuid,
    asset_id uuid,
    final_score numeric,
    score_100 integer,
    risk_level text,
    confidence_level text,
    recommended_action text,
    reason_codes text[],
    limitations text[],
    changed_since_last_refresh text,
    score_breakdown jsonb,
    evidence jsonb,
    metric_status jsonb,
    source_snapshot_ids text[]
  )
  on conflict (id) do update set
    incident_id = excluded.incident_id,
    asset_id = excluded.asset_id,
    final_score = excluded.final_score,
    score_100 = excluded.score_100,
    risk_level = excluded.risk_level,
    confidence_level = excluded.confidence_level,
    recommended_action = excluded.recommended_action,
    reason_codes = excluded.reason_codes,
    limitations = excluded.limitations,
    changed_since_last_refresh = excluded.changed_since_last_refresh,
    score_breakdown = excluded.score_breakdown,
    evidence = excluded.evidence,
    metric_status = excluded.metric_status,
    source_snapshot_ids = excluded.source_snapshot_ids;

  insert into public.responder_actions (
    id,
    recommendation_id,
    action,
    note,
    actor_id,
    actor_name,
    modified_priority,
    recommendation_snapshot,
    created_at
  )
  select
    row.id,
    row.recommendation_id,
    row.action,
    coalesce(row.note, ''),
    nullif(row.actor_id, '')::uuid,
    row.actor_name,
    nullif(row.modified_priority, ''),
    row.recommendation_snapshot,
    row.created_at
  from jsonb_to_recordset(coalesce(p_responder_actions, '[]'::jsonb)) as row(
    id uuid,
    recommendation_id uuid,
    action text,
    note text,
    actor_id text,
    actor_name text,
    modified_priority text,
    recommendation_snapshot jsonb,
    created_at timestamptz
  )
  on conflict (id) do nothing;

  insert into public.audit_events (
    id,
    incident_id,
    recommendation_id,
    actor_id,
    actor_name,
    event_type,
    summary,
    payload,
    created_at
  )
  select
    row.id,
    row.incident_id,
    row.recommendation_id,
    nullif(row.actor_id, '')::uuid,
    row.actor_name,
    row.event_type,
    row.summary,
    coalesce(row.payload, '{}'::jsonb),
    row.created_at
  from jsonb_to_recordset(coalesce(p_audit_events, '[]'::jsonb)) as row(
    id uuid,
    incident_id uuid,
    recommendation_id uuid,
    actor_id text,
    actor_name text,
    event_type text,
    summary text,
    payload jsonb,
    created_at timestamptz
  )
  on conflict (id) do nothing;
end;
$$;

revoke all
on function public.fireafter_persist_bundle(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
from public, anon, authenticated;

grant execute
on function public.fireafter_persist_bundle(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
to service_role;

create or replace function public.fireafter_bundle_persistence_security_version()
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when to_regprocedure('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)') is not null
    then '20260910120000'::text
    else null::text
  end;
$$;

revoke all
on function public.fireafter_bundle_persistence_security_version()
from public, anon, authenticated;

grant execute
on function public.fireafter_bundle_persistence_security_version()
to service_role;
