begin;
create table public.sentinel_plans (
 organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,created_by uuid not null,created_at timestamptz not null,
 primary key(organization_id,incident_id,mode,id),foreign key(organization_id,incident_id,mode) references public.sentinel_incident_state(organization_id,incident_id,mode)
);
create table public.sentinel_plan_revisions (
 organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,plan_id uuid not null,parent_revision_id uuid,
 constraint_revision_id uuid not null,evidence_generation bigint not null,evidence_vector_hash text not null check(evidence_vector_hash ~ '^[a-f0-9]{64}$'),
 body jsonb not null check(octet_length(body::text)<=1048576),evidence_snapshot jsonb not null check(octet_length(evidence_snapshot::text)<=1048576),
 primary key(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,plan_id) references public.sentinel_plans(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,parent_revision_id) references public.sentinel_plan_revisions(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,constraint_revision_id) references public.sentinel_constraints(organization_id,incident_id,mode,id)
);
create table public.sentinel_plan_items (
 organization_id uuid not null,incident_id uuid not null,mode text not null,revision_id uuid not null,task_id uuid not null,task_input jsonb not null,assignment jsonb,
 primary key(organization_id,incident_id,mode,revision_id,task_id),foreign key(organization_id,incident_id,mode,revision_id) references public.sentinel_plan_revisions(organization_id,incident_id,mode,id)
);
create table public.sentinel_plan_dependencies (
 organization_id uuid not null,incident_id uuid not null,mode text not null,revision_id uuid not null,task_id uuid not null,claim_id uuid not null,version_id uuid not null,claim_review_id uuid,
 primary key(organization_id,incident_id,mode,revision_id,task_id,claim_id),
 foreign key(organization_id,incident_id,mode,revision_id,task_id) references public.sentinel_plan_items(organization_id,incident_id,mode,revision_id,task_id),
 foreign key(organization_id,incident_id,mode,claim_id) references public.sentinel_claims(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,version_id) references public.sentinel_document_versions(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,claim_review_id) references public.sentinel_claim_reviews(organization_id,incident_id,mode,id)
);
create table public.sentinel_plan_status (
 organization_id uuid not null,incident_id uuid not null,mode text not null,plan_id uuid not null,current_revision_id uuid not null,
 primary key(organization_id,incident_id,mode),foreign key(organization_id,incident_id,mode,plan_id) references public.sentinel_plans(organization_id,incident_id,mode,id),
 foreign key(organization_id,incident_id,mode,current_revision_id) references public.sentinel_plan_revisions(organization_id,incident_id,mode,id)
);
create table public.sentinel_plan_commands (
 organization_id uuid not null,incident_id uuid not null,mode text not null,actor_id uuid not null,command_id uuid not null,revision_id uuid not null,payload jsonb not null,receipt jsonb not null,
 primary key(organization_id,incident_id,mode,actor_id,command_id),foreign key(organization_id,incident_id,mode,revision_id) references public.sentinel_plan_revisions(organization_id,incident_id,mode,id)
);
create trigger sentinel_plans_immutable before update or delete on public.sentinel_plans for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_plan_revisions_immutable before update or delete on public.sentinel_plan_revisions for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_plan_items_immutable before update or delete on public.sentinel_plan_items for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_plan_dependencies_immutable before update or delete on public.sentinel_plan_dependencies for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_plan_commands_immutable before update or delete on public.sentinel_plan_commands for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_plans enable row level security;alter table public.sentinel_plan_revisions enable row level security;
alter table public.sentinel_plan_items enable row level security;alter table public.sentinel_plan_dependencies enable row level security;
alter table public.sentinel_plan_status enable row level security;alter table public.sentinel_plan_commands enable row level security;
revoke all on table public.sentinel_plans,public.sentinel_plan_revisions,public.sentinel_plan_items,public.sentinel_plan_dependencies,public.sentinel_plan_status,public.sentinel_plan_commands from public,anon,authenticated,service_role;

-- Internal context. Caller holds current membership and incident state; selected assets are share-locked.
create function public.sentinel_plan_context(p_org uuid,p_incident uuid,p_mode text,p_dependencies jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;constraints public.sentinel_constraints%rowtype;config public.sentinel_source_configs%rowtype;
 task jsonb;mapping jsonb;claim public.sentinel_claims%rowtype;review public.sentinel_claim_reviews%rowtype;asset public.assets%rowtype;ref_id uuid;
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
   'payloadHash',encode(sha256(convert_to(x.raw_payload::text,'UTF8')),'hex')) order by x.source_name),'[]'::jsonb) into native_refs
   from (select distinct on(source_name) * from public.source_snapshots where incident_id=p_incident order by source_name,fetched_at desc,id) x;
 snapshot:=jsonb_build_object('sourceConfigurationId',state.current_source_config_revision,'sourceConfigurationHash',config.config_hash,'constraintRevisionId',constraints.id,
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
revoke all on function public.sentinel_plan_context(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;

create function public.sentinel_read_plan_context(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_dependencies jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;
begin
 state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if state.organization_id is null then return null;end if;
 return public.sentinel_plan_context(p_organization_id,p_incident_id,p_mode,p_dependencies);
end;
$$;
revoke all on function public.sentinel_read_plan_context(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_read_plan_context(uuid,uuid,uuid,text,jsonb) to service_role;

-- Independent SQL check; the client solver cannot bypass complete task coverage or occupied-time bounds.
create function public.sentinel_plan_assignments_valid(config jsonb,assignments jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare a jsonb;t jsonb;c jsonb;start_at timestamptz;end_at timestamptz;travel_at timestamptz;occupied jsonb:='[]'::jsonb;
begin
 if jsonb_typeof(assignments) is distinct from 'array' or jsonb_array_length(assignments)<>jsonb_array_length(config->'tasks')
   or (select count(distinct value->>'taskId') from jsonb_array_elements(assignments))<>jsonb_array_length(assignments) then return false;end if;
 for a in select value from jsonb_array_elements(assignments) loop
   if jsonb_typeof(a) is distinct from 'object' or (select count(*) from jsonb_object_keys(a))<>3 or not (a ?& array['taskId','crewId','startsAt']) then return false;end if;
   select value into t from jsonb_array_elements(config->'tasks') where value->>'id'=a->>'taskId';if not found then return false;end if;
   select value into c from jsonb_array_elements(config->'crews') where value->>'id'=a->>'crewId';if not found then return false;end if;
   if t->>'requiredCapability' is null or t->>'durationMinutes' is null or t->>'travelMinutes' is null or t->>'windowFrom' is null or t->>'windowUntil' is null
     or c->>'availableFrom' is null or c->>'availableUntil' is null or jsonb_typeof(c->'capabilities')<>'array' or not c->'capabilities' @> jsonb_build_array(t->>'requiredCapability') then return false;end if;
   start_at:=public.sentinel_constraint_instant(a->'startsAt');if start_at is null then return false;end if;
   end_at:=start_at+(t->>'durationMinutes')::int*interval '1 minute';travel_at:=start_at-(t->>'travelMinutes')::int*interval '1 minute';
   if travel_at<greatest(public.sentinel_constraint_instant(config->'shift'->'startsAt'),public.sentinel_constraint_instant(c->'availableFrom'))
     or end_at>least(public.sentinel_constraint_instant(config->'shift'->'endsAt'),public.sentinel_constraint_instant(c->'availableUntil'))
     or start_at<public.sentinel_constraint_instant(t->'windowFrom') or end_at>public.sentinel_constraint_instant(t->'windowUntil') then return false;end if;
   if exists(select 1 from jsonb_array_elements(occupied) x where x->>'crewId'=a->>'crewId' and (x->>'endsAt')::timestamptz>travel_at and (x->>'startsAt')::timestamptz<end_at) then return false;end if;
   occupied:=occupied||jsonb_build_array(jsonb_build_object('crewId',a->>'crewId','startsAt',travel_at,'endsAt',end_at));
 end loop;
 return true;
exception when data_exception then return false;
end;
$$;
revoke all on function public.sentinel_plan_assignments_valid(jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.sentinel_create_plan_draft(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_command_id uuid,p_expected_parent uuid,
 p_expected_constraint uuid,p_expected_generation bigint,p_expected_vector text,p_dependencies jsonb,p_allocation jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
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
   'evidenceGeneration',p_expected_generation,'evidenceVectorHash',p_expected_vector,'policyRevisionId',null,'state','draft','approvalReady',false,
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
revoke all on function public.sentinel_create_plan_draft(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_create_plan_draft(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,text,jsonb,jsonb) to service_role;

create function public.sentinel_read_plan_draft(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_revision_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;revision public.sentinel_plan_revisions%rowtype;current_id uuid;ctx jsonb;
begin
 state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if state.organization_id is null then return null;end if;
 select current_revision_id into current_id from public.sentinel_plan_status where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode;
 select * into revision from public.sentinel_plan_revisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=coalesce(p_revision_id,current_id);
 if not found then return null;end if;
 if state.current_constraint_revision=revision.constraint_revision_id then
   begin ctx:=public.sentinel_plan_context(p_organization_id,p_incident_id,p_mode,revision.body->'taskDependencies');
   exception when insufficient_privilege or invalid_parameter_value or serialization_failure then ctx:=null;end;
 end if;
 return jsonb_build_object('scope',revision.body->'scope','revision',revision.body,'isCurrentRevision',revision.id=current_id,
   'snapshotMatchesCurrent',coalesce(state.evidence_generation=revision.evidence_generation and ctx->>'evidenceVectorHash'=revision.evidence_vector_hash,false),
   'validity','needs_review','approvalReady',false,'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;
revoke all on function public.sentinel_read_plan_draft(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_plan_draft(uuid,uuid,uuid,text,uuid) to service_role;
create function public.sentinel_find_plan_command(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_command_id uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare prior public.sentinel_plan_commands%rowtype;revision public.sentinel_plan_revisions%rowtype;state public.sentinel_incident_state%rowtype;
begin
 if p_mode is null or p_mode not in ('live','replay','synthetic') or p_command_id is null or jsonb_typeof(p_command) is distinct from 'object'
   or (select count(*) from jsonb_object_keys(p_command))<>5 or not (p_command ?& array['parent','constraint','generation','vector','dependencies']) then raise exception 'Invalid command lookup' using errcode='22023';end if;
 perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in ('analyst','incident_commander') for share;
 if not found then raise exception 'Plan unavailable' using errcode='42501';end if;
 select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for share;
 if not found then raise exception 'Plan unavailable' using errcode='42501';end if;
 select * into prior from public.sentinel_plan_commands where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
 if not found then return null;end if;
 if prior.payload-'allocation'<>p_command then raise exception 'Proposal command changed' using errcode='40001';end if;
 select * into revision from public.sentinel_plan_revisions where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=prior.revision_id;
 return jsonb_build_object('revision',revision.body,'receipt',prior.receipt,'replayed',true);
end;
$$;
revoke all on function public.sentinel_find_plan_command(uuid,uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_find_plan_command(uuid,uuid,uuid,text,uuid,jsonb) to service_role;
commit;
