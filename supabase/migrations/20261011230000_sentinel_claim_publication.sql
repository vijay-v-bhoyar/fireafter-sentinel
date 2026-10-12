-- Sentinel-only citation publication. Quotes remain unreviewed; no marker can close here.
begin;
create table public.sentinel_claims (
  organization_id uuid not null, incident_id uuid not null, mode text not null, id uuid not null,
  document_version_id uuid not null, run_id uuid not null, publication_command_id uuid not null,
  claim_sequence bigint generated always as identity check(claim_sequence between 1 and 9007199254740991),
  excerpt_start integer not null check(excerpt_start>=0), excerpt_end integer not null check(excerpt_end>excerpt_start and excerpt_end<=102400),
  excerpt text not null check(octet_length(excerpt)=excerpt_end-excerpt_start),
  body jsonb not null check(jsonb_typeof(body)='object' and octet_length(body::text)<=131072), created_at timestamptz not null,
  primary key(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,document_version_id) references public.sentinel_document_versions(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
create index sentinel_claim_page on public.sentinel_claims(organization_id,incident_id,mode,document_version_id,claim_sequence);
create table public.sentinel_claim_publications (
  organization_id uuid not null, incident_id uuid not null, mode text not null, run_id uuid not null, command_id uuid not null,
  payload jsonb not null check(octet_length(payload::text)<=131072), receipt jsonb not null,
  primary key(organization_id,incident_id,mode,run_id,command_id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
alter table public.sentinel_claims add foreign key(organization_id,incident_id,mode,run_id,publication_command_id)
  references public.sentinel_claim_publications(organization_id,incident_id,mode,run_id,command_id) deferrable initially deferred;
create trigger sentinel_claims_immutable before update or delete on public.sentinel_claims
  for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_claim_publications_immutable before update or delete on public.sentinel_claim_publications
  for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_claims enable row level security;
alter table public.sentinel_claim_publications enable row level security;
revoke all on table public.sentinel_claims,public.sentinel_claim_publications from public,anon,authenticated,service_role;
revoke all on sequence public.sentinel_claims_claim_sequence_seq from public,anon,authenticated,service_role;

create function public.sentinel_publish_claims(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,
  p_owner uuid,p_fence bigint,p_command_id uuid,p_expected_generation bigint,p_version_ids jsonb,p_claims jsonb,p_transient_texts jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.sentinel_runs%rowtype; state public.sentinel_incident_state%rowtype; cached public.sentinel_claim_publications%rowtype;
  version public.sentinel_document_versions%rowtype; payload jsonb; receipt jsonb; c jsonb; doc_id uuid; claim_id uuid;
  source_text text; quoted text; start_at integer; end_at integer; entity uuid; now_at timestamptz;
  covered integer; quote_range int4multirange; claim_ids jsonb:='[]'::jsonb;
begin
  if p_command_id is null or p_expected_generation is null or p_expected_generation<0 or p_expected_generation>9007199254740991
    or jsonb_typeof(p_version_ids) is distinct from 'array' or jsonb_array_length(p_version_ids) not between 1 and 5
    or jsonb_typeof(p_claims) is distinct from 'array' or jsonb_array_length(p_claims)>25
    or jsonb_typeof(p_transient_texts) is distinct from 'object' or octet_length(p_transient_texts::text)>1048576 then
    raise exception 'Invalid claim publication' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_version_ids) v where jsonb_typeof(v)<>'string')
    or (select count(distinct value::uuid) from jsonb_array_elements_text(p_version_ids))<>jsonb_array_length(p_version_ids)
    or exists(select 1 from jsonb_each(p_transient_texts) t where jsonb_typeof(t.value)<>'string' or t.key<>lower(t.key)
      or not p_version_ids @> jsonb_build_array(t.key) or octet_length(t.value#>>'{}')>102400)
    or (select coalesce(sum(octet_length(value#>>'{}')),0) from jsonb_each(p_transient_texts))>512000 then
    raise exception 'Invalid document or transient text' using errcode='22023'; end if;
  payload:=jsonb_build_object('expectedEvidenceGeneration',p_expected_generation,'versionIds',p_version_ids,'claims',p_claims);
  if octet_length(payload::text)>131072 then raise exception 'Claim command too large' using errcode='22023'; end if;
  r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
  now_at:=date_trunc('milliseconds',clock_timestamp()); perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
  select * into cached from public.sentinel_claim_publications where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and run_id=p_run_id and command_id=p_command_id;
  if found then
    if cached.payload<>payload then raise exception 'Claim command conflict' using errcode='23505'; end if;
    return jsonb_build_object('receipt',cached.receipt,'replayed',true);
  end if;
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode;
  if state.evidence_generation<>p_expected_generation then raise exception 'Evidence changed' using errcode='40001'; end if;
  for doc_id in select value::uuid from jsonb_array_elements_text(p_version_ids) loop
    select * into version from public.sentinel_document_versions where organization_id=p_organization_id and incident_id=p_incident_id
      and mode=p_mode and id=doc_id and source_config_revision=r.source_config_revision;
    if not found or version.availability<>'available' or version.content_permission='metadata_only' or not exists(
      select 1 from public.sentinel_document_heads where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode
        and document_id=version.document_id and version_id=version.id and source_config_revision=r.source_config_revision) then
      raise exception 'Citation source unavailable' using errcode='22023'; end if;
    source_text:=version.normalized_text;
    if version.content_permission='excerpt_only' then source_text:=p_transient_texts->>doc_id::text;
    elsif p_transient_texts ? doc_id::text then raise exception 'Unexpected transient text' using errcode='22023'; end if;
    if source_text is null or octet_length(source_text)<>version.normalized_bytes or normalize(source_text,NFC)<>source_text
      or position(chr(13) in source_text)>0 or left(source_text,1)=chr(65279)
      or encode(sha256(convert_to(source_text,'UTF8')),'hex')<>version.normalized_hash then
      raise exception 'Citation source integrity mismatch' using errcode='22023'; end if;
    -- All retained quotes for an excerpt-only version share one conservative lifetime cap.
    if version.content_permission='excerpt_only' then
      select range_agg(span) into quote_range from (
        select int4range(excerpt_start,excerpt_end,'[)') span from public.sentinel_claims where organization_id=p_organization_id
          and incident_id=p_incident_id and mode=p_mode and document_version_id=doc_id
        union all select int4range((q->>'excerptStart')::integer,(q->>'excerptEnd')::integer,'[)')
          from jsonb_array_elements(p_claims) q where q->>'documentVersionId'=doc_id::text
      ) ranges;
      select coalesce(sum(upper(span)-lower(span)),0) into covered from unnest(quote_range) span;
      if covered>2048 or covered>=version.normalized_bytes then raise exception 'Excerpt retention limit' using errcode='22023'; end if;
    end if;
  end loop;
  for c in select * from jsonb_array_elements(p_claims) loop
    if jsonb_typeof(c) is distinct from 'object' or (select count(*) from jsonb_object_keys(c))<>11
      or c-array['id','documentVersionId','excerptStart','excerptEnd','excerpt','excerptHash','kind','claimText','entityIds','modelVersion','promptVersion']<>'{}'::jsonb
      or exists(select 1 from jsonb_each(c) e where e.value='null'::jsonb)
      or jsonb_typeof(c->'entityIds') is distinct from 'array' or jsonb_array_length(c->'entityIds')>10
      or jsonb_typeof(c->'excerptStart') is distinct from 'number' or (c->>'excerptStart') !~ '^[0-9]+$'
      or jsonb_typeof(c->'excerptEnd') is distinct from 'number' or (c->>'excerptEnd') !~ '^[0-9]+$'
      or exists(select 1 from jsonb_each(c) e where e.key not in ('entityIds','excerptStart','excerptEnd') and jsonb_typeof(e.value)<>'string')
      or length(c->>'claimText') not between 1 and 2000 or c->>'claimText'<>btrim(c->>'claimText') or octet_length(c->>'claimText')>8000
      or length(c->>'modelVersion') not between 1 and 200 or length(c->>'promptVersion') not between 1 and 200
      or c->>'kind' not in ('access_window','road_status','inspection_condition','general_notice') then
      raise exception 'Invalid claim fields' using errcode='22023'; end if;
    claim_id:=(c->>'id')::uuid; doc_id:=(c->>'documentVersionId')::uuid;
    if not p_version_ids @> jsonb_build_array(doc_id::text) or claim_ids @> jsonb_build_array(claim_id::text)
      or exists(select 1 from jsonb_array_elements(c->'entityIds') v where jsonb_typeof(v)<>'string')
      or (select count(distinct value::uuid) from jsonb_array_elements_text(c->'entityIds'))<>jsonb_array_length(c->'entityIds') then
      raise exception 'Claim document or identity mismatch' using errcode='22023'; end if;
    select * into version from public.sentinel_document_versions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=doc_id;
    source_text:=coalesce(version.normalized_text,p_transient_texts->>doc_id::text);
    start_at:=(c->>'excerptStart')::integer; end_at:=(c->>'excerptEnd')::integer;
    if start_at<0 or end_at<=start_at or end_at>version.normalized_bytes then raise exception 'Invalid citation range' using errcode='22023'; end if;
    quoted:=convert_from(substring(convert_to(source_text,'UTF8') from start_at+1 for end_at-start_at),'UTF8');
    if quoted<>c->>'excerpt' or encode(sha256(convert_to(quoted,'UTF8')),'hex')<>c->>'excerptHash' then
      raise exception 'Citation integrity mismatch' using errcode='22023'; end if;
    for entity in select value::uuid from jsonb_array_elements_text(c->'entityIds') loop
      perform 1 from public.assets where id=entity and incident_id=p_incident_id for share;
      if not found then raise exception 'Claim entity unavailable' using errcode='22023'; end if;
    end loop;
    insert into public.sentinel_claims(organization_id,incident_id,mode,id,document_version_id,run_id,publication_command_id,excerpt_start,excerpt_end,excerpt,body,created_at)
      values(p_organization_id,p_incident_id,p_mode,claim_id,doc_id,p_run_id,p_command_id,start_at,end_at,quoted,
        c||jsonb_build_object('id',claim_id,'documentVersionId',doc_id,'scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
          'runId',p_run_id,'createdAt',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),now_at);
    claim_ids:=claim_ids||jsonb_build_array(claim_id);
  end loop;
  perform public.sentinel_assert_lease(r,p_owner,p_fence,date_trunc('milliseconds',clock_timestamp()));
  receipt:=jsonb_build_object('commandId',p_command_id,'runId',p_run_id,'scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'fence',p_fence,'committedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,'versionIds',p_version_ids,'claimIds',claim_ids,'semanticSupport','unreviewed');
  insert into public.sentinel_claim_publications(organization_id,incident_id,mode,run_id,command_id,payload,receipt)
    values(p_organization_id,p_incident_id,p_mode,p_run_id,p_command_id,payload,receipt);
  return jsonb_build_object('receipt',receipt,'replayed',false);
exception when invalid_text_representation or numeric_value_out_of_range or character_not_in_repertoire or data_exception then
  raise exception 'Invalid claim representation' using errcode='22023';
end;
$$;
revoke all on function public.sentinel_publish_claims(uuid,uuid,text,uuid,uuid,bigint,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_publish_claims(uuid,uuid,text,uuid,uuid,bigint,uuid,bigint,jsonb,jsonb,jsonb) to service_role;

create function public.sentinel_read_claims(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_version_id uuid,p_after_sequence bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype; version public.sentinel_document_versions%rowtype; c public.sentinel_claims%rowtype;
  items jsonb:='[]'::jsonb; item jsonb; more boolean:=false; cursor_at bigint:=null; is_current boolean;
begin
  if p_version_id is null or p_after_sequence is null or p_after_sequence<0 or p_after_sequence>9007199254740991 then
    raise exception 'Invalid claim locator' using errcode='22023'; end if;
  state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);
  if state.incident_id is null then return null; end if;
  select * into version from public.sentinel_document_versions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_version_id;
  if not found then return null; end if;
  is_current:=version.source_config_revision=state.current_source_config_revision and exists(select 1 from public.sentinel_document_heads
    where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and document_id=version.document_id and version_id=version.id);
  for c in select * from public.sentinel_claims where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode
    and document_version_id=p_version_id and claim_sequence>p_after_sequence order by claim_sequence limit 26 loop
    item:=jsonb_build_object('sequence',c.claim_sequence,'claim',c.body,'citationVerified',true,'semanticSupport','unreviewed');
    -- Leave envelope/serialization headroom; one stored claim is bounded to 128 KiB.
    if jsonb_array_length(items)=25 or octet_length((items||jsonb_build_array(item))::text)>786432 then more:=true; exit; end if;
    items:=items||jsonb_build_array(item);
    cursor_at:=c.claim_sequence;
  end loop;
  return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'versionId',p_version_id,
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,'currentEvidence',coalesce(is_current,false),
    'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'items',items,'hasMore',more,
    'nextAfterSequence',case when more then cursor_at else null end);
end;
$$;
revoke all on function public.sentinel_read_claims(uuid,uuid,uuid,text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.sentinel_read_claims(uuid,uuid,uuid,text,uuid,bigint) to service_role;
commit;
