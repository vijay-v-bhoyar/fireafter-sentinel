begin;
create table public.sentinel_changes (
  organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,
  marker_id uuid not null,run_id uuid not null,command_id uuid not null,body jsonb not null check(octet_length(body::text)<=131072),
  change_sequence bigint generated always as identity check(change_sequence between 1 and 9007199254740991),
  primary key(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,marker_id) references public.sentinel_source_change_markers(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
create index sentinel_changes_page on public.sentinel_changes(organization_id,incident_id,mode,change_sequence);
create index sentinel_changes_marker on public.sentinel_changes(organization_id,incident_id,mode,marker_id,change_sequence desc);
create table public.sentinel_change_publications (
  organization_id uuid not null,incident_id uuid not null,mode text not null,run_id uuid not null,command_id uuid not null,
  payload jsonb not null check(octet_length(payload::text)<=131072),receipt jsonb not null,
  primary key(organization_id,incident_id,mode,run_id,command_id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
alter table public.sentinel_changes add foreign key(organization_id,incident_id,mode,run_id,command_id)
  references public.sentinel_change_publications(organization_id,incident_id,mode,run_id,command_id) deferrable initially deferred;
create trigger sentinel_changes_immutable before update or delete on public.sentinel_changes for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_change_publications_immutable before update or delete on public.sentinel_change_publications for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_changes enable row level security;
alter table public.sentinel_change_publications enable row level security;
revoke all on table public.sentinel_changes,public.sentinel_change_publications from public,anon,authenticated,service_role;
revoke all on sequence public.sentinel_changes_change_sequence_seq from public,anon,authenticated,service_role;

create function public.sentinel_publish_changes(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,p_owner uuid,p_fence bigint,
  p_command_id uuid,p_expected_generation bigint,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;r public.sentinel_runs%rowtype;prior public.sentinel_change_publications%rowtype;
  marker public.sentinel_source_change_markers%rowtype;version public.sentinel_document_versions%rowtype;previous public.sentinel_document_versions%rowtype;
  claim public.sentinel_claims%rowtype;draft jsonb;payload jsonb;receipt jsonb;body jsonb;ref_id uuid;entity uuid;
  change_ids jsonb:='[]'::jsonb;marker_ids jsonb:='[]'::jsonb;stamp text;
begin
  if p_command_id is null or p_expected_generation is null or p_expected_generation<0 or p_expected_generation>9007199254740991
    or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 5 then raise exception 'Invalid changes' using errcode='22023';end if;
  payload:=jsonb_build_object('expectedEvidenceGeneration',p_expected_generation,'changes',p_changes);
  if octet_length(payload::text)>131072 then raise exception 'Changes too large' using errcode='22023';end if;
  r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);perform public.sentinel_assert_lease(r,p_owner,p_fence,date_trunc('milliseconds',clock_timestamp()));
  select * into prior from public.sentinel_change_publications where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and run_id=p_run_id and command_id=p_command_id;
  if found then if prior.payload<>payload then raise exception 'Command changed' using errcode='40001';end if;
    return jsonb_build_object('receipt',prior.receipt,'replayed',true);end if;
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode;
  if state.evidence_generation<>p_expected_generation then raise exception 'Evidence changed' using errcode='40001';end if;
  for draft in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(draft) is distinct from 'object' or (select count(*) from jsonb_object_keys(draft))<>9
      or exists(select 1 from jsonb_object_keys(draft) k where k not in ('id','markerId','category','materiality','claimIds','affectedEntityIds','explanation','modelVersion','promptVersion'))
      or draft->>'id' is null or draft->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or draft->>'markerId' is null or draft->>'markerId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or draft->>'category' is null or draft->>'category' not in ('addition','substantive','benign','conflict','withdrawal','unresolved')
      or draft->>'materiality' is null or draft->>'materiality' not in ('material','benign','unresolved')
      or jsonb_typeof(draft->'claimIds') is distinct from 'array' or jsonb_array_length(draft->'claimIds')>25
      or jsonb_typeof(draft->'affectedEntityIds') is distinct from 'array' or jsonb_array_length(draft->'affectedEntityIds')>10
      or jsonb_typeof(draft->'explanation') is distinct from 'string' or length(draft->>'explanation') not between 1 and 2000
      or octet_length(draft->>'explanation')>8000 or btrim(draft->>'explanation')<>draft->>'explanation'
      or jsonb_typeof(draft->'modelVersion') is distinct from 'string' or length(draft->>'modelVersion') not between 1 and 200
      or jsonb_typeof(draft->'promptVersion') is distinct from 'string' or length(draft->>'promptVersion') not between 1 and 200
      or ((draft->>'category' in ('conflict','unresolved')) and draft->>'materiality'<>'unresolved')
      or (draft->>'category'='benign' and draft->>'materiality'<>'benign') or (draft->>'category'<>'benign' and draft->>'materiality'='benign')
      or (draft->>'materiality'<>'unresolved' and draft->>'category'<>'withdrawal' and jsonb_array_length(draft->'claimIds')=0)
      or (select count(*) from jsonb_array_elements(draft->'claimIds'))<>(select count(distinct value) from jsonb_array_elements(draft->'claimIds'))
      or (select count(*) from jsonb_array_elements(draft->'affectedEntityIds'))<>(select count(distinct value) from jsonb_array_elements(draft->'affectedEntityIds'))
      or change_ids @> jsonb_build_array(draft->>'id') or marker_ids @> jsonb_build_array(draft->>'markerId')
    then raise exception 'Invalid draft' using errcode='22023';end if;
    select * into marker from public.sentinel_source_change_markers where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=(draft->>'markerId')::uuid;
    if not found then raise exception 'Change unavailable' using errcode='42501';end if;
    select * into version from public.sentinel_document_versions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=marker.version_id;
    if version.source_config_revision<>r.source_config_revision then raise exception 'Configuration changed' using errcode='40001';end if;
    if draft->>'category'='addition' and marker.previous_version_id is not null then raise exception 'Not an addition' using errcode='22023';end if;
    if marker.previous_version_id is null and draft->>'category' in ('substantive','benign') then raise exception 'Comparison requires a previous version' using errcode='22023';end if;
    if draft->>'category'='withdrawal' and version.availability<>'withdrawn' then raise exception 'Not a withdrawal' using errcode='22023';end if;
    if version.availability='withdrawn' and draft->>'category' not in ('withdrawal','unresolved') then raise exception 'Withdrawn source requires review' using errcode='22023';end if;
    if marker.previous_version_id is not null then
      select * into previous from public.sentinel_document_versions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=marker.previous_version_id;
      if (previous.issuer<>version.issuer or previous.jurisdiction<>version.jurisdiction or previous.canonical_url<>version.canonical_url)
        and draft->>'category' not in ('conflict','unresolved') then raise exception 'Authority conflict' using errcode='22023';end if;
    end if;
    for ref_id in select value::uuid from jsonb_array_elements_text(draft->'claimIds') loop
      select * into claim from public.sentinel_claims where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=ref_id;
      if not found or (claim.document_version_id<>marker.version_id and claim.document_version_id is distinct from marker.previous_version_id)
        then raise exception 'Citation unavailable' using errcode='42501';end if;
    end loop;
    for entity in select value::uuid from jsonb_array_elements_text(draft->'affectedEntityIds') loop
      perform 1 from public.assets where id=entity and incident_id=p_incident_id for share;
      if not found or not exists(select 1 from public.sentinel_claims c where c.organization_id=p_organization_id and c.incident_id=p_incident_id and c.mode=p_mode
        and draft->'claimIds' @> jsonb_build_array(c.id::text) and c.body->'entityIds' @> jsonb_build_array(entity::text)) then raise exception 'Uncited entity' using errcode='42501';end if;
    end loop;
    stamp:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    body:=draft||jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'runId',p_run_id,
      'documentId',marker.document_id,'versionId',marker.version_id,'previousVersionId',marker.previous_version_id,'createdAt',stamp,'semanticAccepted',false,'stage','draft');
    insert into public.sentinel_changes(organization_id,incident_id,mode,id,marker_id,run_id,command_id,body)
      values(p_organization_id,p_incident_id,p_mode,(draft->>'id')::uuid,marker.id,p_run_id,p_command_id,body);
    change_ids:=change_ids||jsonb_build_array(draft->>'id');marker_ids:=marker_ids||jsonb_build_array(marker.id::text);
  end loop;
  perform public.sentinel_assert_lease(r,p_owner,p_fence,date_trunc('milliseconds',clock_timestamp()));
  receipt:=jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'runId',p_run_id,
    'commandId',p_command_id,'fence',p_fence,'committedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,'changeIds',change_ids,'markerIds',marker_ids,'semanticAccepted',false);
  insert into public.sentinel_change_publications values(p_organization_id,p_incident_id,p_mode,p_run_id,p_command_id,payload,receipt);
  return jsonb_build_object('receipt',receipt,'replayed',false);
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Invalid draft reference' using errcode='22023';
end;
$$;
revoke all on function public.sentinel_publish_changes(uuid,uuid,text,uuid,uuid,bigint,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_publish_changes(uuid,uuid,text,uuid,uuid,bigint,uuid,bigint,jsonb) to service_role;

create function public.sentinel_read_changes(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_after_sequence bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;c public.sentinel_changes%rowtype;items jsonb:='[]'::jsonb;item jsonb;
  pending bigint;more boolean:=false;cursor_at bigint:=null;latest boolean;current_evidence boolean;
begin
  if p_after_sequence is null or p_after_sequence<0 or p_after_sequence>9007199254740991 then raise exception 'Invalid cursor' using errcode='22023';end if;
  state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if state.organization_id is null then return null;end if;
  select count(*) into pending from public.sentinel_source_change_markers m where m.organization_id=p_organization_id and m.incident_id=p_incident_id and m.mode=p_mode
    and not exists(select 1 from public.sentinel_changes x where x.organization_id=m.organization_id and x.incident_id=m.incident_id and x.mode=m.mode and x.marker_id=m.id);
  for c in select * from public.sentinel_changes where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and change_sequence>p_after_sequence order by change_sequence limit 26 loop
    latest:=not exists(select 1 from public.sentinel_changes x where x.organization_id=c.organization_id and x.incident_id=c.incident_id and x.mode=c.mode and x.marker_id=c.marker_id and x.change_sequence>c.change_sequence);
    current_evidence:=exists(select 1 from public.sentinel_document_heads h where h.organization_id=c.organization_id and h.incident_id=c.incident_id and h.mode=c.mode
      and h.document_id=(c.body->>'documentId')::uuid and h.version_id=(c.body->>'versionId')::uuid and h.source_config_revision=state.current_source_config_revision);
    item:=jsonb_build_object('sequence',c.change_sequence,'change',c.body,'isLatestDraft',latest,'currentEvidence',current_evidence);
    if jsonb_array_length(items)=25 or octet_length((items||jsonb_build_array(item))::text)>786432 then more:=true;exit;end if;
    items:=items||jsonb_build_array(item);cursor_at:=c.change_sequence;
  end loop;
  return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,'classificationPendingMarkers',pending,
    'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'items',items,'hasMore',more,'nextAfterSequence',case when more then cursor_at else null end);
end;
$$;
revoke all on function public.sentinel_read_changes(uuid,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.sentinel_read_changes(uuid,uuid,uuid,text,bigint) to service_role;
commit;
