-- Sentinel-only leased evidence publication; no semantic approval or provider execution.
begin;
create table public.sentinel_document_heads (
  organization_id uuid not null, incident_id uuid not null, mode text not null, document_id uuid not null,
  version_id uuid not null, source_config_revision uuid not null,
  primary key(organization_id,incident_id,mode,document_id),
  foreign key(organization_id,incident_id,mode,document_id,version_id,source_config_revision)
    references public.sentinel_document_versions(organization_id,incident_id,mode,document_id,id,source_config_revision)
);
create table public.sentinel_source_change_markers (
  id uuid not null default gen_random_uuid(), organization_id uuid not null, incident_id uuid not null, mode text not null,
  document_id uuid not null, version_id uuid not null, previous_version_id uuid, run_id uuid not null,
  generation bigint not null check(generation>0), created_at timestamptz not null,
  primary key(organization_id,incident_id,mode,id), unique(organization_id,incident_id,mode,generation),
  foreign key(organization_id,incident_id,mode,document_id) references public.sentinel_documents(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,version_id) references public.sentinel_document_versions(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,previous_version_id) references public.sentinel_document_versions(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
create table public.sentinel_evidence_publications (
  organization_id uuid not null, incident_id uuid not null, mode text not null, run_id uuid not null, command_id uuid not null,
  payload jsonb not null, receipt jsonb not null,
  primary key(organization_id,incident_id,mode,run_id,command_id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
create trigger sentinel_source_change_markers_immutable before update or delete on public.sentinel_source_change_markers
  for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_evidence_publications_immutable before update or delete on public.sentinel_evidence_publications
  for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_document_heads enable row level security;
alter table public.sentinel_source_change_markers enable row level security;
alter table public.sentinel_evidence_publications enable row level security;
revoke all on table public.sentinel_document_heads,public.sentinel_source_change_markers,public.sentinel_evidence_publications
  from public,anon,authenticated,service_role;

-- Matches the v1 application's JSON-stringified string/null identity array.
create function public.sentinel_version_identity(v jsonb) returns text
language sql immutable set search_path=pg_catalog as $$
  select encode(sha256(convert_to('['||string_agg(coalesce(to_json(t.value)::text,'null'),',' order by t.ordinality)||']','UTF8')),'hex')
  from unnest(array[v#>>'{scope,organizationId}',v#>>'{scope,incidentId}',v#>>'{scope,mode}',
    v->>'documentId',v->>'sourceConfigRevision','sentinel-text-v1',v->>'normalizedHash',v->>'issuer',v->>'jurisdiction',v->>'canonicalUrl',
    case when v->>'publishedAt' is null then null else to_char((v->>'publishedAt')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    case when v->>'effectiveFrom' is null then null else to_char((v->>'effectiveFrom')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    case when v->>'effectiveUntil' is null then null else to_char((v->>'effectiveUntil')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    v->>'availability',v->>'contentPermission']) with ordinality t(value,ordinality);
$$;
revoke all on function public.sentinel_version_identity(jsonb) from public,anon,authenticated,service_role;

create function public.sentinel_publish_evidence(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,
  p_owner uuid,p_fence bigint,p_command_id uuid,p_observations jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype; s public.sentinel_incident_state%rowtype;
  c public.sentinel_source_configs%rowtype; old public.sentinel_evidence_publications%rowtype;
  observation jsonb; v jsonb; registration jsonb; doc_id uuid; version_id uuid; previous_id uuid; event_id uuid; marker_id uuid;
  version_hash text; now_at timestamptz; requested_at timestamptz; retrieved_at timestamptz;
  changed boolean; outcome text; results jsonb:='[]'; receipt jsonb; total_bytes integer:=0;
begin
  if p_command_id is null or p_observations is null or jsonb_typeof(p_observations)<>'array'
    or jsonb_array_length(p_observations) not between 1 and 5 or octet_length(p_observations::text)>1048576 then
    raise exception 'Invalid publication' using errcode='22023'; end if;
  r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
  now_at:=date_trunc('milliseconds',clock_timestamp());
  perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
  select * into old from public.sentinel_evidence_publications where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and run_id=p_run_id and command_id=p_command_id;
  if found then
    if old.payload<>p_observations then raise exception 'Publication conflict' using errcode='23505'; end if;
    return jsonb_build_object('receipt',old.receipt,'replayed',true);
  end if;
  select * into c from public.sentinel_source_configs where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and id=r.source_config_revision;
  if c.configuration->>'schemaVersion' is distinct from '1' or jsonb_typeof(c.configuration->'sources') is distinct from 'array'
    or jsonb_array_length(c.configuration->'sources') not between 1 and 5 then
    raise exception 'Invalid source registry' using errcode='22023'; end if;
  if (select count(distinct x->>'documentId') from jsonb_array_elements(p_observations) x)<>jsonb_array_length(p_observations)
    or (select count(distinct x->>'documentId') from jsonb_array_elements(c.configuration->'sources') x)<>jsonb_array_length(c.configuration->'sources')
    or (select count(distinct x->>'documentKey') from jsonb_array_elements(c.configuration->'sources') x)<>jsonb_array_length(c.configuration->'sources')
    or (select count(distinct x->>'canonicalUrl') from jsonb_array_elements(c.configuration->'sources') x)<>jsonb_array_length(c.configuration->'sources') then
    raise exception 'Duplicate source identity' using errcode='22023'; end if;
  select * into s from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode;
  for observation in select x from jsonb_array_elements(p_observations) x loop
    doc_id:=(observation->>'documentId')::uuid; v:=observation->'version'; marker_id:=null; version_id:=null; version_hash:=null; changed:=false;
    requested_at:=(observation->>'requestedAt')::timestamptz;
    if requested_at is null or requested_at<r.created_at or requested_at>now_at or observation->>'outcome' is null
      or observation->>'providerRequestId' is not null and length(observation->>'providerRequestId') not between 1 and 200
      or observation->>'observedBytes' is null or (observation->>'observedBytes')::integer not between 0 and 1048576 then
      raise exception 'Invalid retrieval interval or bounds' using errcode='22023'; end if;
    select x into registration from jsonb_array_elements(c.configuration->'sources') x where x->>'documentId'=doc_id::text;
    if not found or registration->>'documentKey' is null or length(registration->>'documentKey') not between 1 and 200 then
      raise exception 'Unregistered source' using errcode='22023'; end if;
    insert into public.sentinel_documents(id,organization_id,incident_id,mode,document_key)
      values(doc_id,p_organization_id,p_incident_id,p_mode,registration->>'documentKey') on conflict do nothing;
    if not exists(select 1 from public.sentinel_documents where organization_id=p_organization_id and incident_id=p_incident_id
      and mode=p_mode and id=doc_id and document_key=registration->>'documentKey') then
      raise exception 'Document identity conflict' using errcode='23505'; end if;
    previous_id:=null;
    select h.version_id into previous_id from public.sentinel_document_heads h where h.organization_id=p_organization_id
      and h.incident_id=p_incident_id and h.mode=p_mode and h.document_id=doc_id;
    if observation->>'outcome'='observed' then
      if v is null or jsonb_typeof(v)<>'object' or v#>>'{scope,organizationId}' is distinct from p_organization_id::text
        or v#>>'{scope,incidentId}' is distinct from p_incident_id::text or v#>>'{scope,mode}' is distinct from p_mode
        or v->>'documentId' is distinct from doc_id::text or v->>'sourceConfigRevision' is distinct from r.source_config_revision::text
        or v->>'canonicalUrl' is distinct from registration->>'canonicalUrl' or v->>'issuer' is distinct from registration->>'issuer'
        or v->>'jurisdiction' is distinct from registration->>'jurisdiction' or v->>'contentPermission' is distinct from registration->>'contentPermission'
        or v->>'schemaVersion' is distinct from '1' or v->>'normalizationVersion' is distinct from 'sentinel-text-v1'
        or v->>'availability' is null or v->>'availability' not in ('available','withdrawn','incomplete')
        or v->>'normalizedBytes' is null or (v->>'normalizedBytes')::integer not between 0 and 102400
        or v->>'id' is null or v->>'identityHash' is null or v->>'normalizedHash' is null or v->>'rawHash' is null then
        raise exception 'Version scope or registry mismatch' using errcode='22023'; end if;
      retrieved_at:=(v->>'retrievedAt')::timestamptz;
      if retrieved_at is null or retrieved_at<requested_at or retrieved_at>now_at
        or (v->>'contentPermission'='full_text' and (v->>'normalizedText' is null
          or octet_length(v->>'normalizedText')<>(v->>'normalizedBytes')::integer
          or encode(sha256(convert_to(v->>'normalizedText','UTF8')),'hex')<>v->>'normalizedHash'))
        or (v->>'contentPermission'<>'full_text' and v->>'normalizedText' is not null)
        or public.sentinel_version_identity(v)<>v->>'identityHash' then
        raise exception 'Version integrity or clock mismatch' using errcode='22023'; end if;
      total_bytes:=total_bytes+(v->>'normalizedBytes')::integer;
      if total_bytes>512000 then raise exception 'Source capacity exceeded' using errcode='22023'; end if;
      version_hash:=v->>'identityHash';
      select d.id into version_id from public.sentinel_document_versions d where d.organization_id=p_organization_id
        and d.incident_id=p_incident_id and d.mode=p_mode and d.document_id=doc_id and d.identity_hash=version_hash;
      if not found then
        version_id:=(v->>'id')::uuid;
        insert into public.sentinel_document_versions(id,organization_id,incident_id,mode,document_id,source_config_revision,
          schema_version,normalization_version,identity_hash,raw_hash,normalized_hash,normalized_bytes,normalized_text,issuer,jurisdiction,
          canonical_url,published_at,effective_from,effective_until,retrieved_at,availability,content_permission)
        values(version_id,p_organization_id,p_incident_id,p_mode,doc_id,r.source_config_revision,1,'sentinel-text-v1',version_hash,
          v->>'rawHash',v->>'normalizedHash',(v->>'normalizedBytes')::integer,v->>'normalizedText',v->>'issuer',v->>'jurisdiction',v->>'canonicalUrl',
          (v->>'publishedAt')::timestamptz,(v->>'effectiveFrom')::timestamptz,(v->>'effectiveUntil')::timestamptz,retrieved_at,v->>'availability',v->>'contentPermission');
      end if;
      changed:=previous_id is distinct from version_id;
      if changed then
        update public.sentinel_incident_state set evidence_generation=evidence_generation+1,
          unresolved_source_change_count=unresolved_source_change_count+1
          where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode returning * into s;
        insert into public.sentinel_source_change_markers(organization_id,incident_id,mode,document_id,version_id,previous_version_id,run_id,generation,created_at)
          values(p_organization_id,p_incident_id,p_mode,doc_id,version_id,previous_id,p_run_id,s.evidence_generation,now_at) returning id into marker_id;
        insert into public.sentinel_document_heads(organization_id,incident_id,mode,document_id,version_id,source_config_revision)
          values(p_organization_id,p_incident_id,p_mode,doc_id,version_id,r.source_config_revision)
          on conflict(organization_id,incident_id,mode,document_id) do update set version_id=excluded.version_id,source_config_revision=excluded.source_config_revision;
      end if;
      outcome:=case when v->>'availability'='withdrawn' then 'withdrawn' when v->>'availability'='incomplete' then 'incomplete'
        when changed then 'version' else 'same_version' end;
    elsif observation->>'outcome' in ('failed','incomplete') then
      if v is not null or observation->>'safeErrorCode' is null
        or observation->>'safeErrorCode' not in ('SOURCE_UNAVAILABLE','PROVIDER_TIMEOUT','PROVIDER_PARTIAL','UNSUPPORTED_FORMAT','INPUT_INVALID') then
        raise exception 'Invalid unavailable-source event' using errcode='22023'; end if;
      outcome:=observation->>'outcome';
    else raise exception 'Invalid observation outcome' using errcode='22023'; end if;
    insert into public.sentinel_retrieval_events(organization_id,incident_id,mode,document_id,source_config_revision,checked_version_id,
      requested_at,completed_at,outcome,observed_raw_hash,observed_bytes,provider_request_id,safe_error_code)
    values(p_organization_id,p_incident_id,p_mode,doc_id,r.source_config_revision,version_id,requested_at,now_at,outcome,
      case when v is null then null else v->>'rawHash' end,(observation->>'observedBytes')::integer,observation->>'providerRequestId',
      case when v is null then observation->>'safeErrorCode' else null end) returning id into event_id;
    results:=results||jsonb_build_array(jsonb_build_object('documentId',doc_id,'eventId',event_id,'versionId',version_id,'previousVersionId',previous_id,
      'identityHash',version_hash,'markerId',marker_id,'changed',changed,'outcome',outcome));
  end loop;
  -- A lease/deadline that expires during validation cannot commit a late result.
  now_at:=date_trunc('milliseconds',clock_timestamp());
  perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
  receipt:=jsonb_build_object('commandId',p_command_id,'runId',p_run_id,'scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'fence',p_fence,'committedAt',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceGeneration',s.evidence_generation,'unresolvedSourceChanges',s.unresolved_source_change_count,'observations',results);
  insert into public.sentinel_evidence_publications(organization_id,incident_id,mode,run_id,command_id,payload,receipt)
    values(p_organization_id,p_incident_id,p_mode,p_run_id,p_command_id,p_observations,receipt);
  return jsonb_build_object('receipt',receipt,'replayed',false);
exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
  raise exception 'Invalid publication representation' using errcode='22023';
end;
$$;
revoke all on function public.sentinel_publish_evidence(uuid,uuid,text,uuid,uuid,bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_publish_evidence(uuid,uuid,text,uuid,uuid,bigint,uuid,jsonb) to service_role;
commit;
