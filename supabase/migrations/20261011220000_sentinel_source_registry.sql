-- Sentinel only. Operator admission is provisioned by the database owner on an admitted new target.
begin;
-- Completion timestamps may tie within one millisecond. Use a database-assigned append order for latest retrieval.
alter table public.sentinel_retrieval_events add column event_sequence bigint generated always as identity;
create index sentinel_latest_retrieval on public.sentinel_retrieval_events(organization_id,incident_id,mode,document_id,source_config_revision,event_sequence desc);
create table public.sentinel_source_operators (
  organization_id uuid not null references public.organizations(id), user_id uuid not null references auth.users(id),
  admitted_at timestamptz not null default clock_timestamp(), primary key(organization_id,user_id)
);
create table public.sentinel_source_config_commands (
  organization_id uuid not null, incident_id uuid not null, mode text not null, actor_id uuid not null,
  command_id uuid not null, payload jsonb not null, receipt jsonb not null, config_revision uuid not null,
  primary key(organization_id,incident_id,mode,actor_id,command_id),
  foreign key(organization_id,incident_id,mode,config_revision) references public.sentinel_source_configs(organization_id,incident_id,mode,id)
);
create trigger sentinel_source_config_commands_immutable before update or delete on public.sentinel_source_config_commands
  for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_source_operators enable row level security;
alter table public.sentinel_source_config_commands enable row level security;
revoke all on table public.sentinel_source_operators,public.sentinel_source_config_commands from public,anon,authenticated,service_role;

-- Compact JSON string-array encoding matches sourceConfigurationHash; jsonb whitespace/key order does not enter identity.
create function public.sentinel_source_config_hash(p_configuration jsonb) returns text
language plpgsql immutable set search_path=pg_catalog as $$
declare source jsonb; encoded text:='[1,['; first_item boolean:=true; host text; value text; field text;
begin
  if p_configuration is null or jsonb_typeof(p_configuration) is distinct from 'object' or
    (select count(*) from jsonb_object_keys(p_configuration))<>2 or p_configuration->'schemaVersion' is distinct from '1'::jsonb or
    jsonb_typeof(p_configuration->'sources') is distinct from 'array' then
    raise exception 'Invalid source configuration' using errcode='22023';
  end if;
  if jsonb_array_length(p_configuration->'sources') not between 1 and 5 then
    raise exception 'Invalid source count' using errcode='22023';
  end if;
  for source in select * from jsonb_array_elements(p_configuration->'sources') loop
    if jsonb_typeof(source)<>'object' or (select count(*) from jsonb_object_keys(source))<>6 then
      raise exception 'Invalid source registration' using errcode='22023';
    end if;
    foreach field in array array['documentId','documentKey','canonicalUrl','issuer','jurisdiction','contentPermission'] loop
      value:=source->>field;
      if jsonb_typeof(source->field) is distinct from 'string' or value is null or value<>btrim(value) or length(value)=0 then
        raise exception 'Invalid source field' using errcode='22023';
      end if;
    end loop;
    if (source->>'documentId') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' or
      length(source->>'documentKey')>200 or length(source->>'issuer')>200 or length(source->>'jurisdiction')>200 or
      source->>'contentPermission' not in ('full_text','excerpt_only','metadata_only') or length(source->>'canonicalUrl')>2048 then
      raise exception 'Invalid source registration' using errcode='22023';
    end if;
    host:=substring(source->>'canonicalUrl' from '^https://([^/?#]+)');
    host:=regexp_replace(host,':443$','');
    if host is null or host !~ '^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$' or host ~ '^[0-9.]+$' or
      host ~ '(^|\.)(localhost|local|internal|test|invalid)$' or source->>'canonicalUrl' ~ '#' then
      raise exception 'Unadmitted source URL' using errcode='22023';
    end if;
    if not first_item then encoded:=encoded||','; end if;
    first_item:=false;
    encoded:=encoded||'['||(select string_agg(to_json(source->>k)::text,',' order by position)
      from unnest(array['documentId','documentKey','canonicalUrl','issuer','jurisdiction','contentPermission']) with ordinality as keys(k,position))||']';
  end loop;
  foreach field in array array['documentId','documentKey','canonicalUrl'] loop
    if (select count(distinct v->>field) from jsonb_array_elements(p_configuration->'sources') v)<>jsonb_array_length(p_configuration->'sources') then
      raise exception 'Duplicate source identity' using errcode='22023';
    end if;
  end loop;
  return encode(sha256(convert_to(encoded||']]','UTF8')),'hex');
end;
$$;
revoke all on function public.sentinel_source_config_hash(jsonb) from public,anon,authenticated,service_role;

create function public.sentinel_activate_source_config(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,
  p_command_id uuid,p_expected_config uuid,p_configuration jsonb,p_config_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare state public.sentinel_incident_state%rowtype; prior public.sentinel_source_config_commands%rowtype;
  config public.sentinel_source_configs%rowtype; source jsonb; payload jsonb; receipt jsonb; revision uuid;
  now_at timestamptz; changed boolean;
begin
  if p_command_id is null or p_mode is null or p_mode not in ('live','replay','synthetic') or
    p_config_hash is null or p_config_hash<>public.sentinel_source_config_hash(p_configuration) then
    raise exception 'Invalid activation' using errcode='22023';
  end if;
  -- Membership -> source-operator admission -> organization execution -> incident state -> runs.
  perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role='incident_commander' for share;
  if not found then raise exception 'Sources unavailable' using errcode='42501'; end if;
  perform 1 from public.sentinel_source_operators where organization_id=p_organization_id and user_id=p_actor_id for share;
  if not found then raise exception 'Sources unavailable' using errcode='42501'; end if;
  if not exists(select 1 from public.incidents where organization_id=p_organization_id and id=p_incident_id) then
    raise exception 'Sources unavailable' using errcode='42501';
  end if;
  insert into public.sentinel_org_runtime(organization_id) values(p_organization_id) on conflict do nothing;
  perform 1 from public.sentinel_org_runtime where organization_id=p_organization_id for update;
  insert into public.sentinel_incident_state(organization_id,incident_id,mode) values(p_organization_id,p_incident_id,p_mode) on conflict do nothing;
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
  payload:=jsonb_build_object('expectedConfigRevision',p_expected_config,'configuration',p_configuration,'configHash',p_config_hash);
  select * into prior from public.sentinel_source_config_commands where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
  if found then
    if prior.payload<>payload then raise exception 'Activation conflict' using errcode='23505'; end if;
    return jsonb_build_object('receipt',prior.receipt,'replayed',true);
  end if;
  if state.current_source_config_revision is distinct from p_expected_config then raise exception 'Configuration changed' using errcode='40001'; end if;
  select * into config from public.sentinel_source_configs where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and id=state.current_source_config_revision;
  changed:=config.id is null or config.configuration<>p_configuration;
  revision:=config.id;
  if not changed and config.config_hash<>p_config_hash then raise exception 'Configuration integrity failed' using errcode='22023'; end if;
  if changed then
    for source in select * from jsonb_array_elements(p_configuration->'sources') loop
      if exists(select 1 from public.sentinel_documents where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode
        and ((id=(source->>'documentId')::uuid and document_key<>source->>'documentKey') or (document_key=source->>'documentKey' and id<>(source->>'documentId')::uuid))) then
        raise exception 'Document identity changed' using errcode='23505';
      end if;
      insert into public.sentinel_documents(id,organization_id,incident_id,mode,document_key)
        values((source->>'documentId')::uuid,p_organization_id,p_incident_id,p_mode,source->>'documentKey') on conflict do nothing;
    end loop;
    revision:=gen_random_uuid();
    insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by)
      values(revision,p_organization_id,p_incident_id,p_mode,p_configuration,p_config_hash,p_actor_id);
    update public.sentinel_incident_state set current_source_config_revision=revision,evidence_generation=evidence_generation+1
      where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode returning * into state;
    update public.sentinel_runs set status='failed',stage='configuration_changed',fence=fence+1,lease_owner=null,lease_until=null
      where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode
        and status in ('queued','retrieving','interpreting','validating','ready_for_review');
  end if;
  now_at:=date_trunc('milliseconds',clock_timestamp());
  receipt:=jsonb_build_object('commandId',p_command_id,'actorId',p_actor_id,
    'scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'configRevision',revision,'previousConfigRevision',p_expected_config,'configHash',p_config_hash,
    'evidenceGeneration',state.evidence_generation,'changed',changed,'committedAt',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  insert into public.sentinel_source_config_commands(organization_id,incident_id,mode,actor_id,command_id,payload,receipt,config_revision)
    values(p_organization_id,p_incident_id,p_mode,p_actor_id,p_command_id,payload,receipt,revision);
  return jsonb_build_object('receipt',receipt,'replayed',false);
end;
$$;
revoke all on function public.sentinel_activate_source_config(uuid,uuid,uuid,text,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.sentinel_activate_source_config(uuid,uuid,uuid,text,uuid,uuid,jsonb,text) to service_role;

-- Locks maintain one coherent generation and hold current membership through the private read transaction.
create function public.sentinel_lock_evidence_reader(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text)
returns public.sentinel_incident_state language plpgsql security definer set search_path=pg_catalog,public as $$
declare state public.sentinel_incident_state%rowtype;
begin
  if p_mode is null or p_mode not in ('live','replay','synthetic') then raise exception 'Invalid mode' using errcode='22023'; end if;
  perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id
    and role in ('incident_commander','analyst','viewer') for share;
  if not found then raise exception 'Evidence unavailable' using errcode='42501'; end if;
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for share;
  return state;
end;
$$;
revoke all on function public.sentinel_lock_evidence_reader(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.sentinel_read_evidence_summary(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare state public.sentinel_incident_state%rowtype; config public.sentinel_source_configs%rowtype; source jsonb;
  version public.sentinel_document_versions%rowtype; event public.sentinel_retrieval_events%rowtype;
  documents jsonb:='[]'::jsonb; version_summary jsonb; event_summary jsonb;
begin
  state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);
  if state.incident_id is null then return null; end if;
  select * into config from public.sentinel_source_configs where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and id=state.current_source_config_revision;
  for source in select * from jsonb_array_elements(config.configuration->'sources') loop
    select v.* into version from public.sentinel_document_heads h join public.sentinel_document_versions v
      on (v.organization_id,v.incident_id,v.mode,v.document_id,v.id,v.source_config_revision)=
        (h.organization_id,h.incident_id,h.mode,h.document_id,h.version_id,h.source_config_revision)
      where h.organization_id=p_organization_id and h.incident_id=p_incident_id and h.mode=p_mode and h.document_id=(source->>'documentId')::uuid;
    version_summary:=case when version.id is null then null else jsonb_build_object('id',version.id,'sourceConfigRevision',version.source_config_revision,
      'identityHash',version.identity_hash,'retrievedAt',to_char(version.retrieved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'publishedAt',case when version.published_at is null then null else to_char(version.published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'effectiveFrom',case when version.effective_from is null then null else to_char(version.effective_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'effectiveUntil',case when version.effective_until is null then null else to_char(version.effective_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'availability',version.availability,'contentPermission',version.content_permission,'normalizedBytes',version.normalized_bytes) end;
    select * into event from public.sentinel_retrieval_events where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode
      and document_id=(source->>'documentId')::uuid and source_config_revision=config.id order by event_sequence desc limit 1;
    event_summary:=case when event.id is null then null else jsonb_build_object('id',event.id,'checkedVersionId',event.checked_version_id,
      'requestedAt',to_char(event.requested_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'completedAt',to_char(event.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'outcome',event.outcome,'safeErrorCode',event.safe_error_code) end;
    documents:=documents||jsonb_build_array(jsonb_build_object('documentId',source->>'documentId','currentVersion',version_summary,
      'matchesConfiguration',coalesce(version.source_config_revision=config.id,false),'latestRetrieval',event_summary));
  end loop;
  return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'sourceConfigRevision',config.id,'configHash',config.config_hash,'configuration',config.configuration,
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,
    'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'documents',documents);
end;
$$;
revoke all on function public.sentinel_read_evidence_summary(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.sentinel_read_evidence_summary(uuid,uuid,uuid,text) to service_role;

create function public.sentinel_read_source_changes(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_after_generation bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare state public.sentinel_incident_state%rowtype; marker public.sentinel_source_change_markers%rowtype;
  items jsonb:='[]'::jsonb; more boolean:=false; cursor_at bigint:=null;
begin
  if p_after_generation is null or p_after_generation<0 or p_after_generation>9007199254740991 then
    raise exception 'Invalid cursor' using errcode='22023';
  end if;
  state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);
  if state.incident_id is null then return null; end if;
  for marker in select * from public.sentinel_source_change_markers where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and generation>p_after_generation order by generation asc limit 26 loop
    if jsonb_array_length(items)=25 then more:=true; exit; end if;
    items:=items||jsonb_build_array(jsonb_build_object('id',marker.id,'documentId',marker.document_id,'versionId',marker.version_id,
      'previousVersionId',marker.previous_version_id,'runId',marker.run_id,'evidenceGeneration',marker.generation,
      'createdAt',to_char(marker.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    cursor_at:=marker.generation;
  end loop;
  return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,
    'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'items',items,'hasMore',more,
    'nextAfterGeneration',case when more then cursor_at else null end);
end;
$$;
revoke all on function public.sentinel_read_source_changes(uuid,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.sentinel_read_source_changes(uuid,uuid,uuid,text,bigint) to service_role;
commit;
