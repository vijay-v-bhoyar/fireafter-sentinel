begin;
create table public.sentinel_marker_reviews (
  organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,
  marker_id uuid not null,change_id uuid,actor_id uuid not null,command_id uuid not null,previous_review_id uuid,
  review_sequence bigint generated always as identity check(review_sequence between 1 and 9007199254740991),
  version_ids uuid[] not null,claim_review_vector jsonb not null check(octet_length(claim_review_vector::text)<=131072),
  payload jsonb not null check(octet_length(payload::text)<=131072),body jsonb not null,receipt jsonb not null,
  primary key(organization_id,incident_id,mode,id),unique(organization_id,incident_id,mode,actor_id,command_id),
  foreign key(organization_id,incident_id,mode,marker_id) references public.sentinel_source_change_markers(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,change_id) references public.sentinel_changes(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,previous_review_id) references public.sentinel_marker_reviews(organization_id,incident_id,mode,id)
);
create table public.sentinel_marker_status (
  organization_id uuid not null,incident_id uuid not null,mode text not null,marker_id uuid not null,
  latest_review_id uuid not null,resolved boolean not null,version_ids uuid[] not null,
  reason text not null check(reason in ('human_resolve','human_hold','claim_changed','claim_review_changed','draft_changed')),
  primary key(organization_id,incident_id,mode,marker_id),
  foreign key(organization_id,incident_id,mode,marker_id) references public.sentinel_source_change_markers(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,latest_review_id) references public.sentinel_marker_reviews(organization_id,incident_id,mode,id)
);
create table public.sentinel_marker_invalidations (
  organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null default gen_random_uuid(),
  marker_id uuid not null,review_id uuid not null,cause_kind text not null check(cause_kind in ('claim_changed','claim_review_changed','draft_changed')),
  cause_id uuid not null,created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,marker_id) references public.sentinel_source_change_markers(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,review_id) references public.sentinel_marker_reviews(organization_id,incident_id,mode,id)
);
create trigger sentinel_marker_reviews_immutable before update or delete on public.sentinel_marker_reviews for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_marker_invalidations_immutable before update or delete on public.sentinel_marker_invalidations for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_marker_reviews enable row level security;
alter table public.sentinel_marker_status enable row level security;
alter table public.sentinel_marker_invalidations enable row level security;
revoke all on table public.sentinel_marker_reviews,public.sentinel_marker_status,public.sentinel_marker_invalidations from public,anon,authenticated,service_role;
revoke all on sequence public.sentinel_marker_reviews_review_sequence_seq from public,anon,authenticated,service_role;

-- Caller holds membership plus incident state SHARE/UPDATE. This helper has no runtime grant.
create function public.sentinel_marker_context(p_org uuid,p_incident uuid,p_mode text,p_marker uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare marker public.sentinel_source_change_markers%rowtype;state public.sentinel_incident_state%rowtype;
  current_version public.sentinel_document_versions%rowtype;v public.sentinel_document_versions%rowtype;
  latest_change public.sentinel_changes%rowtype;status public.sentinel_marker_status%rowtype;latest_review public.sentinel_marker_reviews%rowtype;
  versions uuid[];metadata jsonb:='[]'::jsonb;issues jsonb:='[]'::jsonb;vector jsonb;unresolved bigint;supported bigint;vector_hash text;entity uuid;missing_entity boolean:=false;
begin
  select * into marker from public.sentinel_source_change_markers where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=p_marker;
  if not found then return null;end if;
  select * into state from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode;
  select * into current_version from public.sentinel_document_versions where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=marker.version_id;
  versions:=array_remove(array[marker.version_id,marker.previous_version_id],null);
  if current_version.source_config_revision is distinct from state.current_source_config_revision or not exists(select 1 from public.sentinel_document_heads
    where organization_id=p_org and incident_id=p_incident and mode=p_mode and document_id=marker.document_id and version_id=marker.version_id)
    then issues:=issues||'"source_not_current"'::jsonb;end if;
  if current_version.availability<>'available' then issues:=issues||'"source_unavailable"'::jsonb;end if;
  for v in select * from public.sentinel_document_versions where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=any(versions) order by id loop
    metadata:=metadata||jsonb_build_array(jsonb_build_object('id',v.id,'normalizedHash',v.normalized_hash,'contentPermission',v.content_permission,'availability',v.availability));
    if v.content_permission<>'full_text' or v.normalized_text is null then issues:=issues||'"retained_full_text_required"'::jsonb;end if;
    if v.issuer<>current_version.issuer or v.jurisdiction<>current_version.jurisdiction or v.canonical_url<>current_version.canonical_url then issues:=issues||'"authority_conflict"'::jsonb;end if;
    if not exists(select 1 from public.sentinel_claim_publications cp where cp.organization_id=p_org and cp.incident_id=p_incident and cp.mode=p_mode
      and cp.payload->'versionIds' @> jsonb_build_array(v.id::text)) then issues:=issues||'"extraction_not_recorded"'::jsonb;end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('claimId',c.id,'reviewId',cr.id,'support',cr.body->>'support','applicability',cr.body->>'applicability',
    'provenance',cr.body->>'provenance','conflict',cr.body->>'conflict') order by c.claim_sequence),'[]'::jsonb),
    count(*) filter(where cr.id is null or cr.body->>'support'='unresolved' or cr.body->>'applicability'='unresolved' or cr.body->>'provenance'<>'verified' or cr.body->>'conflict'<>'clear'),
    count(*) filter(where c.document_version_id=marker.version_id and cr.body->>'support'='supported' and cr.body->>'applicability'='applicable' and cr.body->>'provenance'='verified' and cr.body->>'conflict'='clear')
    into vector,unresolved,supported from public.sentinel_claims c left join lateral(select * from public.sentinel_claim_reviews x where x.organization_id=c.organization_id
      and x.incident_id=c.incident_id and x.mode=c.mode and x.claim_id=c.id order by x.review_sequence desc limit 1) cr on true
    where c.organization_id=p_org and c.incident_id=p_incident and c.mode=p_mode and c.document_version_id=any(versions);
  vector_hash:=encode(sha256(convert_to(jsonb_build_object('versions',metadata,'claims',vector)::text,'UTF8')),'hex');
  for entity in select distinct value::uuid from public.sentinel_claims c cross join lateral jsonb_array_elements_text(c.body->'entityIds')
    where c.organization_id=p_org and c.incident_id=p_incident and c.mode=p_mode and c.document_version_id=any(versions) loop
    perform 1 from public.assets where id=entity and incident_id=p_incident for share;
    if not found then missing_entity:=true;end if;
  end loop;
  if missing_entity then issues:=issues||'"entity_candidates_changed"'::jsonb;end if;
  if unresolved>0 then issues:=issues||'"unresolved_claim_reviews"'::jsonb;end if;
  if octet_length(vector::text)>131072 then issues:=issues||'"review_vector_too_large"'::jsonb;end if;
  select * into latest_change from public.sentinel_changes where organization_id=p_org and incident_id=p_incident and mode=p_mode and marker_id=p_marker order by change_sequence desc limit 1;
  if not found then issues:=issues||'"comparison_missing"'::jsonb;end if;
  select * into status from public.sentinel_marker_status where organization_id=p_org and incident_id=p_incident and mode=p_mode and marker_id=p_marker;
  select * into latest_review from public.sentinel_marker_reviews where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=status.latest_review_id;
  return jsonb_build_object('scope',jsonb_build_object('organizationId',p_org,'incidentId',p_incident,'mode',p_mode),'markerId',p_marker,'documentId',marker.document_id,
    'versionIds',to_jsonb(versions),'versions',metadata,'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,
    'reviewVectorHash',vector_hash,'claimReviewVector',vector,'unresolvedClaimReviews',unresolved,'supportedCurrentClaims',supported,'resolutionIssues',issues,
    'latestChangeId',latest_change.id,'latestReviewId',status.latest_review_id,'resolved',coalesce(status.resolved,false),'reason',status.reason,
    'review',latest_review.body,'receipt',latest_review.receipt,'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;
revoke all on function public.sentinel_marker_context(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;

create function public.sentinel_read_marker_review(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_marker_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;
begin
  state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if state.organization_id is null then return null;end if;
  return public.sentinel_marker_context(p_organization_id,p_incident_id,p_mode,p_marker_id)-'claimReviewVector';
end;
$$;
revoke all on function public.sentinel_read_marker_review(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_marker_review(uuid,uuid,uuid,text,uuid) to service_role;

create function public.sentinel_record_marker_review(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_marker_id uuid,p_command_id uuid,p_review jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;prior public.sentinel_marker_reviews%rowtype;ctx jsonb;payload jsonb;body jsonb;receipt jsonb;
  review_id uuid:=gen_random_uuid();receipt_id uuid:=gen_random_uuid();expected_id uuid;change_id uuid;stamp text;vector jsonb;versions uuid[];was_resolved boolean;
begin
  if p_mode is null or p_mode not in ('live','replay','synthetic') or p_marker_id is null or p_command_id is null
    or jsonb_typeof(p_review) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_review))<>9
    or exists(select 1 from jsonb_object_keys(p_review) k where k not in ('expectedEvidenceGeneration','expectedReviewId','expectedReviewVectorHash','changeId','action','materiality','completeReview','provenance','note'))
    or jsonb_typeof(p_review->'expectedEvidenceGeneration') is distinct from 'number' or p_review->>'expectedEvidenceGeneration' !~ '^[0-9]{1,16}$'
    or (p_review->>'expectedEvidenceGeneration')::numeric>9007199254740990
    or jsonb_typeof(p_review->'expectedReviewId') not in ('null','string') or jsonb_typeof(p_review->'changeId') not in ('null','string')
    or p_review->>'expectedReviewVectorHash' is null or p_review->>'expectedReviewVectorHash' !~ '^[0-9a-f]{64}$'
    or p_review->>'action' is null or p_review->>'action' not in ('resolve','hold')
    or p_review->>'materiality' is null or p_review->>'materiality' not in ('material','benign','unresolved')
    or jsonb_typeof(p_review->'completeReview') is distinct from 'boolean' or p_review->>'provenance' is null or p_review->>'provenance' not in ('verified','unresolved')
    or jsonb_typeof(p_review->'note') is distinct from 'string' or length(p_review->>'note') not between 1 and 2000 or octet_length(p_review->>'note')>8000
    or btrim(p_review->>'note')='' or octet_length(p_review::text)>131072
    then raise exception 'Invalid marker review' using errcode='22023';end if;
  expected_id:=(p_review->>'expectedReviewId')::uuid;change_id:=(p_review->>'changeId')::uuid;
  perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Review unavailable' using errcode='42501';end if;
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
  if not found then raise exception 'Review unavailable' using errcode='42501';end if;
  payload:=jsonb_build_object('markerId',p_marker_id,'review',p_review);
  select * into prior from public.sentinel_marker_reviews where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
  if found then if prior.payload<>payload then raise exception 'Command changed' using errcode='40001';end if;return jsonb_build_object('review',prior.body,'receipt',prior.receipt,'replayed',true);end if;
  ctx:=public.sentinel_marker_context(p_organization_id,p_incident_id,p_mode,p_marker_id);if ctx is null then raise exception 'Review unavailable' using errcode='42501';end if;
  if state.evidence_generation<>(p_review->>'expectedEvidenceGeneration')::bigint or (ctx->>'latestReviewId')::uuid is distinct from expected_id
    or (ctx->>'latestChangeId')::uuid is distinct from change_id or ctx->>'reviewVectorHash'<>p_review->>'expectedReviewVectorHash'
    then raise exception 'Review changed' using errcode='40001';end if;
  if p_review->>'action'='resolve' and (jsonb_array_length(ctx->'resolutionIssues')<>0 or not (p_review->>'completeReview')::boolean
    or p_review->>'provenance'<>'verified' or p_review->>'materiality'='unresolved' or change_id is null
    or (p_review->>'materiality'='material' and (ctx->>'supportedCurrentClaims')::bigint=0)) then raise exception 'Unresolved source review' using errcode='40001';end if;
  vector:=ctx->'claimReviewVector';if octet_length(vector::text)>131072 then raise exception 'Review vector exceeds supported bounds' using errcode='22023';end if;
  versions:=array(select value::uuid from jsonb_array_elements_text(ctx->'versionIds'));
  was_resolved:=(ctx->>'resolved')::boolean;
  if p_review->>'action'='resolve' and not was_resolved then
    if state.unresolved_source_change_count<=0 then raise exception 'Marker count changed' using errcode='40001';end if;
    state.unresolved_source_change_count:=state.unresolved_source_change_count-1;
  elsif p_review->>'action'='hold' and was_resolved then state.unresolved_source_change_count:=state.unresolved_source_change_count+1;end if;
  update public.sentinel_incident_state set evidence_generation=evidence_generation+1,unresolved_source_change_count=state.unresolved_source_change_count
    where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode returning * into state;
  stamp:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  body:=jsonb_build_object('id',review_id,'scope',ctx->'scope','markerId',p_marker_id,'changeId',change_id,'actorId',p_actor_id,'receiptId',receipt_id,
    'createdAt',stamp,'action',p_review->>'action','materiality',p_review->>'materiality','completeReview',p_review->'completeReview',
    'provenance',p_review->>'provenance','note',p_review->>'note','reviewVectorHash',ctx->>'reviewVectorHash');
  receipt:=jsonb_build_object('id',receipt_id,'scope',ctx->'scope','markerId',p_marker_id,'reviewId',review_id,'actorId',p_actor_id,'commandId',p_command_id,
    'previousReviewId',expected_id,'changeId',change_id,'committedAt',stamp,'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,
    'markerResolved',p_review->>'action'='resolve','reviewVectorHash',ctx->>'reviewVectorHash');
  insert into public.sentinel_marker_reviews(organization_id,incident_id,mode,id,marker_id,change_id,actor_id,command_id,previous_review_id,version_ids,claim_review_vector,payload,body,receipt)
    values(p_organization_id,p_incident_id,p_mode,review_id,p_marker_id,change_id,p_actor_id,p_command_id,expected_id,versions,vector,payload,body,receipt);
  insert into public.sentinel_marker_status values(p_organization_id,p_incident_id,p_mode,p_marker_id,review_id,p_review->>'action'='resolve',versions,
    case when p_review->>'action'='resolve' then 'human_resolve' else 'human_hold' end)
    on conflict(organization_id,incident_id,mode,marker_id) do update set latest_review_id=excluded.latest_review_id,resolved=excluded.resolved,version_ids=excluded.version_ids,reason=excluded.reason;
  return jsonb_build_object('review',body,'receipt',receipt,'replayed',false);
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Invalid marker review reference' using errcode='22023';
end;
$$;
revoke all on function public.sentinel_record_marker_review(uuid,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_record_marker_review(uuid,uuid,uuid,text,uuid,uuid,jsonb) to service_role;

-- All callers already hold the incident-state write lock. No generation increment here:
-- human reviews increment before INSERT; publishers increment once after the whole batch.
create function public.sentinel_reopen_marker_dependencies() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare target_version uuid;target_marker uuid;cause text;status public.sentinel_marker_status%rowtype;n bigint:=0;state public.sentinel_incident_state%rowtype;
begin
  if tg_table_name='sentinel_claims' then target_version:=new.document_version_id;cause:='claim_changed';
  elsif tg_table_name='sentinel_claim_reviews' then
    select c.document_version_id into target_version from public.sentinel_claims c where c.organization_id=new.organization_id and c.incident_id=new.incident_id and c.mode=new.mode and c.id=new.claim_id;
    cause:='claim_review_changed';
  else target_marker:=new.marker_id;cause:='draft_changed';end if;
  for status in select * from public.sentinel_marker_status s where s.organization_id=new.organization_id and s.incident_id=new.incident_id and s.mode=new.mode and s.resolved
    and (s.marker_id=target_marker or target_version=any(s.version_ids)) for update loop
    update public.sentinel_marker_status set resolved=false,reason=cause where organization_id=status.organization_id and incident_id=status.incident_id and mode=status.mode and marker_id=status.marker_id;
    insert into public.sentinel_marker_invalidations(organization_id,incident_id,mode,marker_id,review_id,cause_kind,cause_id)
      values(status.organization_id,status.incident_id,status.mode,status.marker_id,status.latest_review_id,cause,new.id);n:=n+1;
  end loop;
  if n>0 then update public.sentinel_incident_state set unresolved_source_change_count=unresolved_source_change_count+n
    where organization_id=new.organization_id and incident_id=new.incident_id and mode=new.mode returning * into state;
    if tg_table_name='sentinel_claim_reviews' then new.receipt:=jsonb_set(new.receipt,'{unresolvedSourceChanges}',to_jsonb(state.unresolved_source_change_count));end if;
  end if;
  return new;
end;
$$;
revoke all on function public.sentinel_reopen_marker_dependencies() from public,anon,authenticated,service_role;
create trigger sentinel_new_claim_reopens_markers before insert on public.sentinel_claims for each row execute function public.sentinel_reopen_marker_dependencies();
create trigger sentinel_new_claim_review_reopens_markers before insert on public.sentinel_claim_reviews for each row execute function public.sentinel_reopen_marker_dependencies();
create trigger sentinel_new_change_reopens_marker before insert on public.sentinel_changes for each row execute function public.sentinel_reopen_marker_dependencies();
-- Existing publishers/reviewer are replaced below with preserved validation, fencing and receipts.

create or replace function public.sentinel_publish_claims(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,
  p_owner uuid,p_fence bigint,p_command_id uuid,p_expected_generation bigint,p_version_ids jsonb,p_claims jsonb,p_transient_texts jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.sentinel_runs%rowtype; state public.sentinel_incident_state%rowtype; cached public.sentinel_claim_publications%rowtype;
  version public.sentinel_document_versions%rowtype; payload jsonb; receipt jsonb; c jsonb; doc_id uuid; claim_id uuid;
  source_text text; quoted text; start_at integer; end_at integer; entity uuid; now_at timestamptz;
  covered integer; quote_range int4multirange; claim_ids jsonb:='[]'::jsonb;
  initial_unresolved bigint;reopened bigint;
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
  initial_unresolved:=state.unresolved_source_change_count;
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
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode;
  reopened:=state.unresolved_source_change_count-initial_unresolved;
  if reopened>0 then
    if state.evidence_generation>=9007199254740991 then raise exception 'Generation exhausted' using errcode='40001';end if;
    update public.sentinel_incident_state set evidence_generation=evidence_generation+1 where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode returning * into state;
  end if;
  receipt:=jsonb_build_object('commandId',p_command_id,'runId',p_run_id,'scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'fence',p_fence,'committedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,'versionIds',p_version_ids,'claimIds',claim_ids,'semanticSupport','unreviewed');
  if reopened>0 then receipt:=receipt||jsonb_build_object('reopenedMarkers',reopened);end if;
  insert into public.sentinel_claim_publications(organization_id,incident_id,mode,run_id,command_id,payload,receipt)
    values(p_organization_id,p_incident_id,p_mode,p_run_id,p_command_id,payload,receipt);
  perform public.sentinel_assert_lease(r,p_owner,p_fence,date_trunc('milliseconds',clock_timestamp()));
  return jsonb_build_object('receipt',receipt,'replayed',false);
exception when invalid_text_representation or numeric_value_out_of_range or character_not_in_repertoire or data_exception then
  raise exception 'Invalid claim representation' using errcode='22023';
end;
$$;

create or replace function public.sentinel_publish_changes(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,p_owner uuid,p_fence bigint,
  p_command_id uuid,p_expected_generation bigint,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;r public.sentinel_runs%rowtype;prior public.sentinel_change_publications%rowtype;
  marker public.sentinel_source_change_markers%rowtype;version public.sentinel_document_versions%rowtype;previous public.sentinel_document_versions%rowtype;
  claim public.sentinel_claims%rowtype;draft jsonb;payload jsonb;receipt jsonb;body jsonb;ref_id uuid;entity uuid;
  change_ids jsonb:='[]'::jsonb;marker_ids jsonb:='[]'::jsonb;stamp text;
  initial_unresolved bigint;reopened bigint;
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
  initial_unresolved:=state.unresolved_source_change_count;
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
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode;
  reopened:=state.unresolved_source_change_count-initial_unresolved;
  if reopened>0 then
    if state.evidence_generation>=9007199254740991 then raise exception 'Generation exhausted' using errcode='40001';end if;
    update public.sentinel_incident_state set evidence_generation=evidence_generation+1 where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode returning * into state;
  end if;
  receipt:=jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'runId',p_run_id,
    'commandId',p_command_id,'fence',p_fence,'committedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,'changeIds',change_ids,'markerIds',marker_ids,'semanticAccepted',false);
  if reopened>0 then receipt:=receipt||jsonb_build_object('reopenedMarkers',reopened);end if;
  insert into public.sentinel_change_publications values(p_organization_id,p_incident_id,p_mode,p_run_id,p_command_id,payload,receipt);
  perform public.sentinel_assert_lease(r,p_owner,p_fence,date_trunc('milliseconds',clock_timestamp()));
  return jsonb_build_object('receipt',receipt,'replayed',false);
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'Invalid draft reference' using errcode='22023';
end;
$$;

create or replace function public.sentinel_record_claim_review(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_claim_id uuid,p_command_id uuid,p_review jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype; claim public.sentinel_claims%rowtype;
  version public.sentinel_document_versions%rowtype; prior public.sentinel_claim_reviews%rowtype;
  latest_id uuid; expected_id uuid; expected_generation bigint; review_id uuid:=gen_random_uuid(); receipt_id uuid:=gen_random_uuid();
  checked_at timestamptz; body jsonb; receipt jsonb; payload jsonb; entity uuid;
begin
  if p_mode is null or p_mode not in ('live','replay','synthetic') or p_claim_id is null or p_command_id is null
    or jsonb_typeof(p_review) is distinct from 'object' or octet_length(p_review::text)>131072
    or (select count(*) from jsonb_object_keys(p_review))<>7
    or exists(select 1 from jsonb_object_keys(p_review) k where k not in ('expectedEvidenceGeneration','expectedReviewId','support','applicability','provenance','conflict','note'))
    or jsonb_typeof(p_review->'expectedEvidenceGeneration') is distinct from 'number' or (p_review->>'expectedEvidenceGeneration') !~ '^[0-9]{1,16}$'
    or (p_review->>'expectedEvidenceGeneration')::numeric>9007199254740990
    or jsonb_typeof(p_review->'expectedReviewId') not in ('null','string')
    or (p_review->>'expectedReviewId' is not null and p_review->>'expectedReviewId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or p_review->>'support' is null or p_review->>'support' not in ('supported','unsupported','unresolved')
    or p_review->>'applicability' is null or p_review->>'applicability' not in ('applicable','not_applicable','unresolved')
    or p_review->>'provenance' is null or p_review->>'provenance' not in ('verified','unresolved')
    or p_review->>'conflict' is null or p_review->>'conflict' not in ('clear','unresolved')
    or jsonb_typeof(p_review->'note') is distinct from 'string' or length(p_review->>'note')>2000 or octet_length(p_review->>'note')>8000
  then raise exception 'Invalid review' using errcode='22023'; end if;
  expected_id:=(p_review->>'expectedReviewId')::uuid; expected_generation:=(p_review->>'expectedEvidenceGeneration')::bigint;
  perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Review unavailable' using errcode='42501'; end if;
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
  if not found then raise exception 'Review unavailable' using errcode='42501'; end if;
  payload:=jsonb_build_object('claimId',p_claim_id,'review',p_review);
  select * into prior from public.sentinel_claim_reviews where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
  if found then
    if prior.payload<>payload then raise exception 'Review command changed' using errcode='40001'; end if;
    return jsonb_build_object('review',prior.body,'receipt',prior.receipt,'replayed',true);
  end if;
  select * into claim from public.sentinel_claims where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_claim_id;
  if not found then raise exception 'Review unavailable' using errcode='42501'; end if;
  select id into latest_id from public.sentinel_claim_reviews where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and claim_id=p_claim_id order by review_sequence desc limit 1;
  if state.evidence_generation<>expected_generation or latest_id is distinct from expected_id then raise exception 'Review changed' using errcode='40001'; end if;
  select * into version from public.sentinel_document_versions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=claim.document_version_id;
  if version.source_config_revision is distinct from state.current_source_config_revision or version.availability<>'available'
    or not exists(select 1 from public.sentinel_document_heads where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and document_id=version.document_id and version_id=version.id)
  then raise exception 'Claim evidence changed' using errcode='40001'; end if;
  for entity in select value::uuid from jsonb_array_elements_text(claim.body->'entityIds') loop
    perform 1 from public.assets where id=entity and incident_id=p_incident_id for share;
    if not found then raise exception 'Claim entity changed' using errcode='40001'; end if;
  end loop;
  checked_at:=clock_timestamp();
  update public.sentinel_incident_state set evidence_generation=evidence_generation+1 where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode returning * into state;
  body:=jsonb_build_object('id',review_id,'scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'claimId',p_claim_id,'actorId',p_actor_id,'receiptId',receipt_id,'createdAt',to_char(checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'support',p_review->>'support','applicability',p_review->>'applicability','provenance',p_review->>'provenance','conflict',p_review->>'conflict','note',p_review->>'note');
  receipt:=jsonb_build_object('id',receipt_id,'commandId',p_command_id,'claimId',p_claim_id,'reviewId',review_id,'previousReviewId',latest_id,
    'scope',body->'scope','actorId',p_actor_id,'committedAt',to_char(checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'evidenceGeneration',state.evidence_generation,
    'unresolvedSourceChanges',state.unresolved_source_change_count);
  insert into public.sentinel_claim_reviews as inserted(organization_id,incident_id,mode,id,claim_id,actor_id,command_id,previous_review_id,evidence_generation,payload,body,receipt,created_at)
    values(p_organization_id,p_incident_id,p_mode,review_id,p_claim_id,p_actor_id,p_command_id,latest_id,state.evidence_generation,payload,body,receipt,checked_at) returning inserted.receipt into receipt;
  return jsonb_build_object('review',body,'receipt',receipt,'replayed',false);
end;
$$;
commit;
