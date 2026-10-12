-- Human claim review is append-only. It never resolves a source marker or approves a plan.
begin;
create table public.sentinel_claim_reviews (
  organization_id uuid not null, incident_id uuid not null, mode text not null, id uuid not null,
  claim_id uuid not null, actor_id uuid not null, command_id uuid not null, previous_review_id uuid,
  review_sequence bigint generated always as identity check(review_sequence between 1 and 9007199254740991),
  evidence_generation bigint not null check(evidence_generation between 1 and 9007199254740991),
  payload jsonb not null check(octet_length(payload::text)<=131072), body jsonb not null, receipt jsonb not null,
  created_at timestamptz not null,
  primary key(organization_id,incident_id,mode,id),
  unique(organization_id,incident_id,mode,actor_id,command_id),
  foreign key(organization_id,incident_id,mode,claim_id) references public.sentinel_claims(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,previous_review_id) references public.sentinel_claim_reviews(organization_id,incident_id,mode,id)
);
create index sentinel_claim_review_latest on public.sentinel_claim_reviews(organization_id,incident_id,mode,claim_id,review_sequence desc);
create trigger sentinel_claim_reviews_immutable before update or delete on public.sentinel_claim_reviews
  for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_claim_reviews enable row level security;
revoke all on table public.sentinel_claim_reviews from public,anon,authenticated,service_role;
revoke all on sequence public.sentinel_claim_reviews_review_sequence_seq from public,anon,authenticated,service_role;

create function public.sentinel_record_claim_review(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_claim_id uuid,p_command_id uuid,p_review jsonb)
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
  insert into public.sentinel_claim_reviews(organization_id,incident_id,mode,id,claim_id,actor_id,command_id,previous_review_id,evidence_generation,payload,body,receipt,created_at)
    values(p_organization_id,p_incident_id,p_mode,review_id,p_claim_id,p_actor_id,p_command_id,latest_id,state.evidence_generation,payload,body,receipt,checked_at);
  return jsonb_build_object('review',body,'receipt',receipt,'replayed',false);
end;
$$;
revoke all on function public.sentinel_record_claim_review(uuid,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_record_claim_review(uuid,uuid,uuid,text,uuid,uuid,jsonb) to service_role;

create function public.sentinel_read_claim_review(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_claim_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype; claim public.sentinel_claims%rowtype; version public.sentinel_document_versions%rowtype;
  latest public.sentinel_claim_reviews%rowtype; is_current boolean;
begin
  state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);
  select * into claim from public.sentinel_claims where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_claim_id;
  if state.organization_id is null or not found then return null; end if;
  select * into version from public.sentinel_document_versions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=claim.document_version_id;
  is_current:=version.source_config_revision=state.current_source_config_revision and version.availability='available'
    and exists(select 1 from public.sentinel_document_heads where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and document_id=version.document_id and version_id=version.id);
  select * into latest from public.sentinel_claim_reviews where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and claim_id=p_claim_id order by review_sequence desc limit 1;
  return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'claimId',p_claim_id,
    'documentVersionId',claim.document_version_id,'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,
    'currentEvidence',coalesce(is_current,false),'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'review',latest.body,'receipt',latest.receipt);
end;
$$;
revoke all on function public.sentinel_read_claim_review(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_claim_review(uuid,uuid,uuid,text,uuid) to service_role;
commit;
