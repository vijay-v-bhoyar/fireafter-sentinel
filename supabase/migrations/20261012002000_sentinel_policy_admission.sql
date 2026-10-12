begin;
create table public.sentinel_policies (
 organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null default gen_random_uuid(),
 source_config_revision uuid not null,configuration jsonb not null,policy_hash text not null check(policy_hash ~ '^[a-f0-9]{64}$'),
 created_by uuid not null,created_at timestamptz not null,primary key(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode) references public.sentinel_incident_state(organization_id,incident_id,mode),
 foreign key(organization_id,incident_id,mode,source_config_revision) references public.sentinel_source_configs(organization_id,incident_id,mode,id),
 check(octet_length(configuration::text)<=131072));
create table public.sentinel_policy_commands (
 organization_id uuid not null,incident_id uuid not null,mode text not null,actor_id uuid not null,command_id uuid not null,revision_id uuid not null,
 payload jsonb not null,receipt jsonb not null,primary key(organization_id,incident_id,mode,actor_id,command_id),
 foreign key(organization_id,incident_id,mode,revision_id) references public.sentinel_policies(organization_id,incident_id,mode,id));
alter table public.sentinel_incident_state add column current_policy_revision uuid;
alter table public.sentinel_incident_state add constraint sentinel_current_policy_fk foreign key(organization_id,incident_id,mode,current_policy_revision)
 references public.sentinel_policies(organization_id,incident_id,mode,id);
alter table public.sentinel_policies enable row level security;
alter table public.sentinel_policy_commands enable row level security;
create trigger sentinel_policies_immutable before update or delete on public.sentinel_policies for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_policy_commands_immutable before update or delete on public.sentinel_policy_commands for each row execute function public.sentinel_reject_evidence_mutation();
revoke all on public.sentinel_policies,public.sentinel_policy_commands from public,anon,authenticated,service_role;

create function public.sentinel_policy_instant(value jsonb) returns timestamptz language plpgsql immutable set search_path=pg_catalog set timezone='UTC' as $$
declare result timestamptz;
begin
 if value is null or jsonb_typeof(value)='null' then return null;end if;
 if jsonb_typeof(value)<>'string' or value#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' then raise exception 'Invalid clock' using errcode='22023';end if;
 result:=(value#>>'{}')::timestamptz;
 if to_char(result at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS')<>left(value#>>'{}',19) then raise exception 'Invalid clock' using errcode='22023';end if;
 return result;
exception when data_exception then raise exception 'Invalid clock' using errcode='22023';
end;$$;
revoke all on function public.sentinel_policy_instant(jsonb) from public,anon,authenticated,service_role;

create function public.sentinel_policy_valid(c jsonb,m text) returns boolean language plpgsql immutable set search_path=pg_catalog set timezone='UTC' as $$
declare r jsonb;
begin
 if m is null or c is null or m not in('live','replay','synthetic') or jsonb_typeof(c)<>'object' or (select count(*) from jsonb_object_keys(c))<>6
  or not(c ?& array['schemaVersion','inputBasis','evaluationAt','documentRules','nativeRules','note']) or c->'schemaVersion'<>'1'::jsonb
  or jsonb_typeof(c->'inputBasis')<>'string' or c->>'inputBasis' not in('user_authored','demo') or jsonb_typeof(c->'note')<>'string' or btrim(c->>'note')='' or octet_length(c->>'note')>2048
  or (m='live' and (c->>'inputBasis'<>'user_authored' or jsonb_typeof(c->'evaluationAt')<>'null'))
  or (m<>'live' and public.sentinel_policy_instant(c->'evaluationAt') is null)
  or jsonb_typeof(c->'documentRules')<>'array' or jsonb_array_length(c->'documentRules') not between 1 and 5
  or jsonb_typeof(c->'nativeRules')<>'array' or jsonb_array_length(c->'nativeRules') not between 1 and 10 then return false;end if;
 if (select count(distinct value->>'documentId') from jsonb_array_elements(c->'documentRules'))<>jsonb_array_length(c->'documentRules')
  or (select count(distinct value->>'sourceKey') from jsonb_array_elements(c->'nativeRules'))<>jsonb_array_length(c->'nativeRules') then return false;end if;
 for r in select value from jsonb_array_elements(c->'documentRules') loop
  if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>4 or not(r ?& array['documentId','maxAgeMinutes','requirePublicationTime','requireEffectiveInterval'])
   or r->>'documentId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   or jsonb_typeof(r->'maxAgeMinutes')<>'number' or (r->>'maxAgeMinutes')::numeric<>trunc((r->>'maxAgeMinutes')::numeric)
   or (r->>'maxAgeMinutes')::numeric not between 1 and 1440
   or jsonb_typeof(r->'requirePublicationTime')<>'boolean' or jsonb_typeof(r->'requireEffectiveInterval')<>'boolean' then return false;end if;
 end loop;
 for r in select value from jsonb_array_elements(c->'nativeRules') loop
  if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>4 or not(r ?& array['sourceKey','maxAgeMinutes','requireProviderTime','requireValidUntil'])
   or r->>'sourceKey' !~ '^[a-z][a-z0-9_-]{0,79}$' or jsonb_typeof(r->'maxAgeMinutes')<>'number'
   or (r->>'maxAgeMinutes')::numeric<>trunc((r->>'maxAgeMinutes')::numeric) or (r->>'maxAgeMinutes')::numeric not between 1 and 1440
   or jsonb_typeof(r->'requireProviderTime')<>'boolean' or jsonb_typeof(r->'requireValidUntil')<>'boolean'
   or (r->>'sourceKey' in('nws','nws-forecast') and (r->'requireProviderTime'<>'true'::jsonb or r->'requireValidUntil'<>'true'::jsonb))
   or (r->>'sourceKey'='usgs-pwfdf' and r->'requireProviderTime'<>'true'::jsonb) then return false;end if;
 end loop;
 return true;
exception when data_exception then return false;
end;$$;
revoke all on function public.sentinel_policy_valid(jsonb,text) from public,anon,authenticated,service_role;

create function public.sentinel_policy_view(r public.sentinel_policies) returns jsonb language sql stable set search_path=pg_catalog set timezone='UTC' as $$
 select jsonb_build_object('id',r.id,'scope',jsonb_build_object('organizationId',r.organization_id,'incidentId',r.incident_id,'mode',r.mode),
 'sourceConfigurationId',r.source_config_revision,'configuration',r.configuration,'policyHash',r.policy_hash,'createdBy',r.created_by,
 'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
revoke all on function public.sentinel_policy_view(public.sentinel_policies) from public,anon,authenticated,service_role;

create function public.sentinel_record_policy(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_command_id uuid,p_expected_policy uuid,
 p_expected_source uuid,p_expected_generation bigint,p_configuration jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s public.sentinel_incident_state%rowtype;prior public.sentinel_policy_commands%rowtype;r public.sentinel_policies%rowtype;
 config public.sentinel_source_configs%rowtype;payload jsonb;receipt jsonb;content_hash text;stamp timestamptz;changed boolean;
begin
 if p_actor_id is null or p_command_id is null or p_expected_source is null or p_expected_generation is null or p_expected_generation not between 0 and 9007199254740991
  or not coalesce(public.sentinel_policy_valid(p_configuration,p_mode),false) or octet_length(p_configuration::text)>131072 then raise exception 'Invalid policy' using errcode='22023';end if;
 perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role='incident_commander' for share;
 if not found then raise exception 'Commander policy authority required' using errcode='42501';end if;
 select * into s from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
 if not found then raise exception 'Policy scope unavailable' using errcode='42501';end if;
 payload:=jsonb_build_object('policy',p_expected_policy,'source',p_expected_source,'generation',p_expected_generation,'configuration',p_configuration);
 select * into prior from public.sentinel_policy_commands where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
 if found then
  if prior.payload<>payload then raise exception 'Policy command changed' using errcode='40001';end if;
  select * into r from public.sentinel_policies where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=prior.revision_id;
  return jsonb_build_object('revision',public.sentinel_policy_view(r),'receipt',prior.receipt,'replayed',true);
 end if;
 if s.current_policy_revision is distinct from p_expected_policy or s.current_source_config_revision is distinct from p_expected_source or s.evidence_generation<>p_expected_generation
  then raise exception 'Policy evidence changed' using errcode='40001';end if;
 select * into config from public.sentinel_source_configs where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_expected_source;
 if not found or jsonb_typeof(config.configuration->'sources') is distinct from 'array' or jsonb_array_length(config.configuration->'sources')<>jsonb_array_length(p_configuration->'documentRules')
  or exists(select 1 from jsonb_array_elements(config.configuration->'sources') x where not exists(select 1 from jsonb_array_elements(p_configuration->'documentRules') d where d->>'documentId'=x->>'documentId'))
  then raise exception 'Every registered source needs a policy rule' using errcode='22023';end if;
 content_hash:=encode(sha256(convert_to(p_configuration::text,'UTF8')),'hex');
 select * into r from public.sentinel_policies where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=s.current_policy_revision;
 changed:=r.id is null or r.policy_hash<>content_hash or r.source_config_revision<>p_expected_source;stamp:=clock_timestamp();
 if changed then
  if s.evidence_generation>=9007199254740991 then raise exception 'Generation exhausted' using errcode='40001';end if;
  insert into public.sentinel_policies values(p_organization_id,p_incident_id,p_mode,gen_random_uuid(),p_expected_source,p_configuration,content_hash,p_actor_id,stamp) returning * into r;
  update public.sentinel_incident_state set current_policy_revision=r.id,evidence_generation=evidence_generation+1 where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode returning * into s;
 end if;
 receipt:=jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'commandId',p_command_id,'actorId',p_actor_id,
  'revisionId',r.id,'previousRevisionId',p_expected_policy,'sourceConfigurationId',p_expected_source,'changed',changed,'committedAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'evidenceGeneration',s.evidence_generation,'unresolvedSourceChanges',s.unresolved_source_change_count);
 insert into public.sentinel_policy_commands values(p_organization_id,p_incident_id,p_mode,p_actor_id,p_command_id,r.id,payload,receipt);
 return jsonb_build_object('revision',public.sentinel_policy_view(r),'receipt',receipt,'replayed',false);
end;$$;
revoke all on function public.sentinel_record_policy(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_record_policy(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,jsonb) to service_role;

create function public.sentinel_read_policy(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s public.sentinel_incident_state%rowtype;r public.sentinel_policies%rowtype;
begin
 s:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if s.organization_id is null then return null;end if;
 select * into r from public.sentinel_policies where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=s.current_policy_revision;
 return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'revision',case when r.id is null then null else public.sentinel_policy_view(r) end,
 'evidenceGeneration',s.evidence_generation,'unresolvedSourceChanges',s.unresolved_source_change_count,'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;$$;
revoke all on function public.sentinel_read_policy(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.sentinel_read_policy(uuid,uuid,uuid,text) to service_role;
-- The context and admission functions are added below in this same migration.

create or replace function public.sentinel_plan_context(p_org uuid,p_incident uuid,p_mode text,p_dependencies jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare state public.sentinel_incident_state%rowtype;constraints public.sentinel_constraints%rowtype;config public.sentinel_source_configs%rowtype;
 policy public.sentinel_policies%rowtype;task jsonb;mapping jsonb;claim public.sentinel_claims%rowtype;review public.sentinel_claim_reviews%rowtype;asset public.assets%rowtype;ref_id uuid;
 documents jsonb;native_refs jsonb;assets jsonb:='[]'::jsonb;claims jsonb:='[]'::jsonb;snapshot jsonb;blockers jsonb:='["policy_not_qualified","native_evidence_not_qualified"]'::jsonb;
 seen jsonb:='[]'::jsonb;mapping_ids jsonb:='[]'::jsonb;current_id uuid;vector_hash text;
begin
 select * into state from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode;
 if not found then return null;end if;
 select * into constraints from public.sentinel_constraints where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=state.current_constraint_revision;
 if not found then raise exception 'Constraints required' using errcode='40001';end if;
 if jsonb_typeof(p_dependencies) is distinct from 'array' or jsonb_array_length(p_dependencies)<>jsonb_array_length(constraints.configuration->'tasks') then raise exception 'Every selected task needs an explicit dependency entry' using errcode='22023';end if;
 for mapping in select value from jsonb_array_elements(p_dependencies) loop
   if jsonb_typeof(mapping) is distinct from 'object' or (select count(*) from jsonb_object_keys(mapping))<>2 or not (mapping ?& array['taskId','claimIds'])
     or mapping->>'taskId' is null or jsonb_typeof(mapping->'claimIds') is distinct from 'array' or jsonb_array_length(mapping->'claimIds')>25
     or mapping_ids @> jsonb_build_array(mapping->>'taskId')
     or not exists(select 1 from jsonb_array_elements(constraints.configuration->'tasks') t where t->>'id'=mapping->>'taskId')
     or (select count(distinct value) from jsonb_array_elements(mapping->'claimIds'))<>jsonb_array_length(mapping->'claimIds') then raise exception 'Invalid dependency map' using errcode='22023';end if;
   mapping_ids:=mapping_ids||jsonb_build_array(mapping->>'taskId');
 end loop;
 for task in select value from jsonb_array_elements(constraints.configuration->'tasks') loop
   select * into asset from public.assets where incident_id=p_incident and id=(task->>'assetId')::uuid for share;
   if not found then raise exception 'Selected asset unavailable' using errcode='42501';end if;
   assets:=assets||jsonb_build_array(jsonb_build_object('taskId',task->>'id','asset',to_jsonb(asset),'assetHash',encode(sha256(convert_to(to_jsonb(asset)::text,'UTF8')),'hex')));
   select value into mapping from jsonb_array_elements(p_dependencies) where value->>'taskId'=task->>'id';
   if jsonb_array_length(mapping->'claimIds')=0 then blockers:=blockers||'"task_evidence_missing"'::jsonb;end if;
   for ref_id in select value::uuid from jsonb_array_elements_text(mapping->'claimIds') loop
     select * into claim from public.sentinel_claims where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=ref_id;
     if not found then raise exception 'Dependency claim unavailable' using errcode='42501';end if;
     if not claim.body->'entityIds' @> jsonb_build_array(task->>'assetId') then blockers:=blockers||'"entity_applicability_unconfirmed"'::jsonb;end if;
     if not exists(select 1 from public.sentinel_document_heads h where h.organization_id=p_org and h.incident_id=p_incident and h.mode=p_mode and h.version_id=claim.document_version_id and h.source_config_revision=state.current_source_config_revision)
       then blockers:=blockers||'"claim_source_not_current"'::jsonb;end if;
     select * into review from public.sentinel_claim_reviews where organization_id=p_org and incident_id=p_incident and mode=p_mode and claim_id=ref_id order by review_sequence desc limit 1;
     if not found or review.body->>'support'<>'supported' or review.body->>'applicability'<>'applicable' or review.body->>'provenance'<>'verified' or review.body->>'conflict'<>'clear'
       then blockers:=blockers||'"claim_support_unresolved"'::jsonb;end if;
     if not seen @> jsonb_build_array(ref_id::text) then
       seen:=seen||jsonb_build_array(ref_id::text);claims:=claims||jsonb_build_array(jsonb_build_object('claim',claim.body,'review',review.body));
     end if;
   end loop;
 end loop;
 if jsonb_array_length(seen)>25 then raise exception 'Dependency capacity exceeded' using errcode='22023';end if;
 select * into config from public.sentinel_source_configs where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=state.current_source_config_revision;
 if config.id is null then blockers:=blockers||'"source_configuration_missing"'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('documentId',h.document_id,'versionId',h.version_id,'configurationId',h.source_config_revision,'identityHash',v.identity_hash,
   'normalizedHash',v.normalized_hash,'availability',v.availability,'contentPermission',v.content_permission,'publishedAt',v.published_at,'effectiveFrom',v.effective_from,'effectiveUntil',v.effective_until) order by h.document_id),'[]'::jsonb)
   into documents from public.sentinel_document_heads h join public.sentinel_document_versions v on v.organization_id=h.organization_id and v.incident_id=h.incident_id and v.mode=h.mode and v.id=h.version_id
   where h.organization_id=p_org and h.incident_id=p_incident and h.mode=p_mode;
 if config.id is not null and exists(select 1 from jsonb_array_elements(config.configuration->'sources') s where not exists(select 1 from public.sentinel_document_heads h
   where h.organization_id=p_org and h.incident_id=p_incident and h.mode=p_mode and h.document_id=(s->>'documentId')::uuid and h.source_config_revision=config.id)) then blockers:=blockers||'"registered_source_missing"'::jsonb;end if;
 if state.unresolved_source_change_count>0 then blockers:=blockers||'"source_reviews_pending"'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'sourceName',x.source_name,'fetchedAt',x.fetched_at,'sourceUpdatedAt',x.source_updated_at,'status',x.status,'stale',x.stale,
   'payloadHash',encode(sha256(convert_to(x.raw_payload::text,'UTF8')),'hex'),'snapshotHash',encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex')) order by x.source_name),'[]'::jsonb) into native_refs
   from (select distinct on(source_name) * from public.source_snapshots where incident_id=p_incident order by source_name,fetched_at desc,id) x;
 select * into policy from public.sentinel_policies where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=state.current_policy_revision;
 snapshot:=jsonb_build_object('policyRevisionId',policy.id,'policyHash',policy.policy_hash,'retrievalChecks',(select coalesce(jsonb_agg(to_jsonb(checks) order by checks.document_id),'[]'::jsonb) from
   (select distinct on(document_id) document_id,id,checked_version_id,source_config_revision,requested_at,completed_at,outcome,event_sequence
    from public.sentinel_retrieval_events where organization_id=p_org and incident_id=p_incident and mode=p_mode and source_config_revision=config.id order by document_id,event_sequence desc) checks),
   'sourceConfigurationId',state.current_source_config_revision,'sourceConfigurationHash',config.config_hash,'constraintRevisionId',constraints.id,
   'constraintHash',constraints.constraint_hash,'documents',documents,'claims',claims,'assets',assets,'nativeSourceReferences',native_refs,'taskDependencies',p_dependencies);
 if octet_length(snapshot::text)>1048576 then raise exception 'Evidence snapshot capacity exceeded' using errcode='22023';end if;
 vector_hash:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 select current_revision_id into current_id from public.sentinel_plan_status where organization_id=p_org and incident_id=p_incident and mode=p_mode;
 return jsonb_build_object('scope',jsonb_build_object('organizationId',p_org,'incidentId',p_incident,'mode',p_mode),'constraintRevision',public.sentinel_constraint_view(constraints),
   'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count,'evidenceVectorHash',vector_hash,'evidenceSnapshot',snapshot,
   'currentPlanRevision',current_id,'blockers',(select coalesce(jsonb_agg(value order by value),'[]'::jsonb) from (select distinct value from jsonb_array_elements(blockers)) b));
exception when data_exception then raise exception 'Invalid dependency value' using errcode='22023';
end;
$$;

create or replace function public.sentinel_create_plan_draft(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_command_id uuid,p_expected_parent uuid,
 p_expected_constraint uuid,p_expected_generation bigint,p_expected_vector text,p_dependencies jsonb,p_allocation jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare state public.sentinel_incident_state%rowtype;prior public.sentinel_plan_commands%rowtype;current_plan public.sentinel_plan_status%rowtype;
 ctx jsonb;payload jsonb;body jsonb;receipt jsonb;revision public.sentinel_plan_revisions%rowtype;plan_id uuid;revision_id uuid:=gen_random_uuid();stamp text;
 task jsonb;mapping jsonb;a jsonb;ref_id uuid;claim public.sentinel_claims%rowtype;review_id uuid;
begin
 if p_mode is null or p_mode not in ('live','replay','synthetic') or p_command_id is null or p_expected_constraint is null or p_expected_generation is null
   or p_expected_generation<0 or p_expected_generation>9007199254740991 or p_expected_vector is null or p_expected_vector !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(p_allocation) is distinct from 'object' or not (p_allocation ?& array['status','selectedTaskIds','assignments','issues'])
   or (select count(*) from jsonb_object_keys(p_allocation))<>4 or p_allocation->>'status' is null or p_allocation->>'status' not in ('feasible','infeasible','incomplete') then raise exception 'Invalid proposal' using errcode='22023';end if;
 payload:=jsonb_build_object('parent',p_expected_parent,'constraint',p_expected_constraint,'generation',p_expected_generation,'vector',p_expected_vector,'dependencies',p_dependencies,'allocation',p_allocation);
 if octet_length(payload::text)>131072 then raise exception 'Proposal too large' using errcode='22023';end if;
 perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in ('analyst','incident_commander') for share;
 if not found then raise exception 'Plan unavailable' using errcode='42501';end if;
 select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
 if not found then raise exception 'Plan unavailable' using errcode='42501';end if;
 select * into prior from public.sentinel_plan_commands where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
 if found then if prior.payload<>payload then raise exception 'Proposal command changed' using errcode='40001';end if;
   select * into revision from public.sentinel_plan_revisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=prior.revision_id;
   return jsonb_build_object('revision',revision.body,'receipt',prior.receipt,'replayed',true);end if;
 select * into current_plan from public.sentinel_plan_status where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
 if current_plan.current_revision_id is distinct from p_expected_parent or state.current_constraint_revision<>p_expected_constraint or state.evidence_generation<>p_expected_generation then raise exception 'Proposal changed' using errcode='40001';end if;
 ctx:=public.sentinel_plan_context(p_organization_id,p_incident_id,p_mode,p_dependencies);
 if ctx->>'evidenceVectorHash'<>p_expected_vector then raise exception 'Evidence changed' using errcode='40001';end if;
 if p_allocation->'selectedTaskIds'<>(select jsonb_agg(value->>'id') from jsonb_array_elements(ctx->'constraintRevision'->'configuration'->'tasks'))
   or jsonb_typeof(p_allocation->'assignments') is distinct from 'array' or jsonb_typeof(p_allocation->'issues') is distinct from 'array'
   or (p_allocation->>'status'='feasible' and not public.sentinel_plan_assignments_valid(ctx->'constraintRevision'->'configuration',p_allocation->'assignments'))
   or (p_allocation->>'status'<>'feasible' and jsonb_array_length(p_allocation->'assignments')<>0) then raise exception 'Invalid complete allocation' using errcode='22023';end if;
 plan_id:=current_plan.plan_id;
 if plan_id is null then plan_id:=gen_random_uuid();insert into public.sentinel_plans values(p_organization_id,p_incident_id,p_mode,plan_id,p_actor_id,clock_timestamp());end if;
 stamp:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 body:=jsonb_build_object('id',revision_id,'planId',plan_id,'scope',ctx->'scope','parentRevisionId',p_expected_parent,'constraintRevisionId',p_expected_constraint,
   'evidenceGeneration',p_expected_generation,'evidenceVectorHash',p_expected_vector,'policyRevisionId',ctx->'evidenceSnapshot'->'policyRevisionId','state','draft','approvalReady',false,
   'createdBy',p_actor_id,'createdAt',stamp,'allocation',p_allocation,'taskDependencies',p_dependencies,'blockers',ctx->'blockers');
 insert into public.sentinel_plan_revisions values(p_organization_id,p_incident_id,p_mode,revision_id,plan_id,p_expected_parent,p_expected_constraint,p_expected_generation,p_expected_vector,body,ctx->'evidenceSnapshot');
 for task in select value from jsonb_array_elements(ctx->'constraintRevision'->'configuration'->'tasks') loop
   select value into a from jsonb_array_elements(p_allocation->'assignments') where value->>'taskId'=task->>'id';
   insert into public.sentinel_plan_items values(p_organization_id,p_incident_id,p_mode,revision_id,(task->>'id')::uuid,task,a);
   select value into mapping from jsonb_array_elements(p_dependencies) where value->>'taskId'=task->>'id';
   for ref_id in select value::uuid from jsonb_array_elements_text(mapping->'claimIds') loop
     select * into claim from public.sentinel_claims where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=ref_id;
     select id into review_id from public.sentinel_claim_reviews where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and claim_id=ref_id order by review_sequence desc limit 1;
     insert into public.sentinel_plan_dependencies values(p_organization_id,p_incident_id,p_mode,revision_id,(task->>'id')::uuid,ref_id,claim.document_version_id,review_id);
   end loop;
 end loop;
 insert into public.sentinel_plan_status values(p_organization_id,p_incident_id,p_mode,plan_id,revision_id)
   on conflict(organization_id,incident_id,mode) do update set current_revision_id=excluded.current_revision_id;
 receipt:=jsonb_build_object('scope',ctx->'scope','commandId',p_command_id,'actorId',p_actor_id,'planId',plan_id,'revisionId',revision_id,'parentRevisionId',p_expected_parent,
   'constraintRevisionId',p_expected_constraint,'evidenceGeneration',p_expected_generation,'evidenceVectorHash',p_expected_vector,'committedAt',stamp,'state','draft');
 insert into public.sentinel_plan_commands values(p_organization_id,p_incident_id,p_mode,p_actor_id,p_command_id,revision_id,payload,receipt);
 return jsonb_build_object('revision',body,'receipt',receipt,'replayed',false);
exception when data_exception then raise exception 'Invalid proposal value' using errcode='22023';
end;
$$;

-- Internal eligibility evaluator. Caller holds current membership/state and native/asset write barriers.
-- Read previews never authorize a terminal decision; a later decision command must rerun this after its locks.
create function public.sentinel_plan_admission(p_org uuid,p_incident uuid,p_mode text,p_revision uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s public.sentinel_incident_state%rowtype;p public.sentinel_policies%rowtype;r public.sentinel_plan_revisions%rowtype;
 v public.sentinel_document_versions%rowtype;event public.sentinel_retrieval_events%rowtype;n public.source_snapshots%rowtype;
 ctx jsonb;rule jsonb;issues jsonb;blockers jsonb:='[]'::jsonb;documents jsonb:='[]'::jsonb;natives jsonb:='[]'::jsonb;
 stamp timestamptz;basis text:='database';until_at timestamptz;payload jsonb;inner_payload jsonb;current_id uuid;current_hash text;
begin
 select * into s from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode;
 select * into r from public.sentinel_plan_revisions where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=p_revision;
 if s.organization_id is null or r.id is null then return null;end if;
 select current_revision_id into current_id from public.sentinel_plan_status where organization_id=p_org and incident_id=p_incident and mode=p_mode;
 select * into p from public.sentinel_policies where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=s.current_policy_revision;
 if current_id is distinct from r.id then blockers:=blockers||'"proposal_superseded"'::jsonb;end if;
 if s.current_constraint_revision is distinct from r.constraint_revision_id then blockers:=blockers||'"constraints_changed"'::jsonb;
 else
  begin
   ctx:=public.sentinel_plan_context(p_org,p_incident,p_mode,r.body->'taskDependencies');
   current_hash:=ctx->>'evidenceVectorHash';
   blockers:=blockers||(select coalesce(jsonb_agg(value),'[]'::jsonb) from jsonb_array_elements(ctx->'blockers') where value#>>'{}' not in('policy_not_qualified','native_evidence_not_qualified'));
  exception when insufficient_privilege or invalid_parameter_value or serialization_failure then blockers:=blockers||'"snapshot_unavailable"'::jsonb;
  end;
 end if;
 if r.evidence_generation<>s.evidence_generation or current_hash is distinct from r.evidence_vector_hash then blockers:=blockers||'"evidence_changed"'::jsonb;end if;
 if not exists(select 1 from public.sentinel_constraints c where c.organization_id=p_org and c.incident_id=p_incident and c.mode=p_mode and c.id=r.constraint_revision_id
    and r.body->'allocation'->>'status'='feasible' and public.sentinel_plan_assignments_valid(c.configuration,r.body->'allocation'->'assignments'))
   then blockers:=blockers||'"allocation_not_feasible"'::jsonb;end if;
 -- This wall-clock read is deliberately after all preview/commit locks and context acquisition.
 stamp:=clock_timestamp();
 if p.id is null then blockers:=blockers||'"policy_missing"'::jsonb;
 else
  if p_mode<>'live' then stamp:=public.sentinel_policy_instant(p.configuration->'evaluationAt');basis:='scenario';end if;
  if p.id::text is distinct from r.body->>'policyRevisionId' or p.source_config_revision is distinct from s.current_source_config_revision then blockers:=blockers||'"policy_changed"'::jsonb;end if;
  if s.unresolved_source_change_count<>0 then blockers:=blockers||'"source_reviews_pending"'::jsonb;end if;
  for rule in select value from jsonb_array_elements(p.configuration->'documentRules') loop
   issues:='[]'::jsonb;
   select ver.* into v from public.sentinel_document_heads h join public.sentinel_document_versions ver on ver.organization_id=h.organization_id and ver.incident_id=h.incident_id and ver.mode=h.mode and ver.id=h.version_id
    where h.organization_id=p_org and h.incident_id=p_incident and h.mode=p_mode and h.document_id=(rule->>'documentId')::uuid and h.source_config_revision=p.source_config_revision;
   if not found then issues:=issues||'"document_missing"'::jsonb;
   else
    select * into event from public.sentinel_retrieval_events where organization_id=p_org and incident_id=p_incident and mode=p_mode and document_id=v.document_id and source_config_revision=p.source_config_revision order by event_sequence desc limit 1;
    if not found or event.outcome not in('version','same_version') or event.checked_version_id is distinct from v.id then issues:=issues||'"document_check_incomplete"'::jsonb;
    elsif event.completed_at>stamp or event.requested_at>stamp or v.retrieved_at>stamp then issues:=issues||'"document_check_in_future"'::jsonb;
    elsif stamp>=event.completed_at+(rule->>'maxAgeMinutes')::int*interval '1 minute' then issues:=issues||'"document_check_expired"'::jsonb;end if;
    if v.availability<>'available' or v.content_permission<>'full_text' or v.normalized_text is null then issues:=issues||'"document_coverage_unavailable"'::jsonb;end if;
    if v.published_at>stamp then issues:=issues||'"document_publication_in_future"'::jsonb;end if;
    if (rule->>'requirePublicationTime')::boolean and v.published_at is null then issues:=issues||'"document_publication_unknown"'::jsonb;end if;
    if (rule->>'requireEffectiveInterval')::boolean and (v.effective_from is null or v.effective_until is null) then issues:=issues||'"document_effective_unknown"'::jsonb;end if;
    if v.effective_from>stamp or v.effective_until<=stamp then issues:=issues||'"document_not_effective"'::jsonb;end if;
    if not exists(select 1 from public.sentinel_claim_publications x where x.organization_id=p_org and x.incident_id=p_incident and x.mode=p_mode and x.payload->'versionIds' @> jsonb_build_array(v.id::text))
     then issues:=issues||'"document_extraction_missing"'::jsonb;end if;
   end if;
   documents:=documents||jsonb_build_array(jsonb_build_object('documentId',rule->>'documentId','versionId',v.id,'issues',issues));blockers:=blockers||issues;
  end loop;
  for rule in select value from jsonb_array_elements(p.configuration->'nativeRules') loop
   issues:='[]'::jsonb;until_at:=null;
   select x.* into n from public.source_snapshots x where x.incident_id=p_incident and coalesce(to_jsonb(x)->>'source_key',x.raw_payload->>'sourceKey')=rule->>'sourceKey' order by x.fetched_at desc,x.id desc limit 1;
   if not found then issues:=issues||'"native_source_missing"'::jsonb;
   else
    payload:=n.raw_payload;inner_payload:=coalesce(payload->'rawPayload',payload);
    if payload->>'sentinelMode' is distinct from p_mode or payload->>'dataOrigin' is distinct from p_mode then issues:=issues||'"native_mode_unbound"'::jsonb;end if;
    if n.status<>'online' or n.stale or coalesce(to_jsonb(n)->>'coverage_status',payload->>'coverageStatus') is distinct from 'available' then issues:=issues||'"native_coverage_unavailable"'::jsonb;end if;
    if n.fetched_at>stamp then issues:=issues||'"native_check_in_future"'::jsonb;
    elsif stamp>=n.fetched_at+(rule->>'maxAgeMinutes')::int*interval '1 minute' then issues:=issues||'"native_check_expired"'::jsonb;end if;
    if n.source_updated_at>stamp then issues:=issues||'"native_publication_in_future"'::jsonb;end if;
    if (rule->>'requireProviderTime')::boolean and (n.source_updated_at is null or payload->>'sourceTimeBasis' is distinct from 'provider') then issues:=issues||'"native_provider_time_unknown"'::jsonb;end if;
    begin until_at:=public.sentinel_policy_instant(payload->'validUntil');
    exception when invalid_parameter_value or data_exception then issues:=issues||'"native_validity_invalid"'::jsonb;end;
    if (rule->>'requireValidUntil')::boolean and until_at is null then issues:=issues||'"native_validity_unknown"'::jsonb;end if;
    if until_at<=stamp then issues:=issues||'"native_validity_expired"'::jsonb;end if;
    if rule->>'sourceKey'='usgs-pwfdf' and inner_payload->>'analysisGeometryVersion' is distinct from '2026-09-14-provider-resolution-v1' then issues:=issues||'"native_geometry_unqualified"'::jsonb;end if;
    if rule->>'sourceKey'='mtbs-burn-severity' and inner_payload->>'interpretationVersion' is distinct from '2026-09-12-source-semantics-v1' then issues:=issues||'"native_interpretation_unqualified"'::jsonb;end if;
   end if;
   natives:=natives||jsonb_build_array(jsonb_build_object('sourceKey',rule->>'sourceKey','snapshotId',n.id,'issues',issues));blockers:=blockers||issues;
  end loop;
 end if;
 select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into blockers from(select distinct value from jsonb_array_elements(blockers)) b;
 return jsonb_build_object('scope',jsonb_build_object('organizationId',p_org,'incidentId',p_incident,'mode',p_mode),'planRevisionId',r.id,'policyRevisionId',p.id,
  'currentPlanRevisionId',current_id,'evidenceGeneration',s.evidence_generation,'evidenceVectorHash',current_hash,
  'checkedAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'timeBasis',basis,'eligible',jsonb_array_length(blockers)=0,'approvalReady',false,
  'blockers',blockers,'documentChecks',documents,'nativeChecks',natives);
end;$$;
revoke all on function public.sentinel_plan_admission(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;

create function public.sentinel_preview_plan_admission(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_revision_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog set timezone='UTC' as $$
declare s public.sentinel_incident_state%rowtype;
begin
 perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in('viewer','analyst','incident_commander') for share;
 if not found then raise exception 'Policy read unavailable' using errcode='42501';end if;
 -- Coarse read barriers cover legacy native/asset writers that do not advance Sentinel generation.
 -- They serialize writes for the short preview; real multi-session qualification remains required.
 lock table public.assets,public.source_snapshots in share mode;
 s:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if s.organization_id is null then return null;end if;
 return public.sentinel_plan_admission(p_organization_id,p_incident_id,p_mode,p_revision_id);
end;$$;
revoke all on function public.sentinel_preview_plan_admission(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_preview_plan_admission(uuid,uuid,uuid,text,uuid) to service_role;
commit;
