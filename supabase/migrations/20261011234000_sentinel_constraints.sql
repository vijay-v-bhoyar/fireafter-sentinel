begin;
create table public.sentinel_constraints (
  organization_id uuid not null,incident_id uuid not null,mode text not null,id uuid not null,
  configuration jsonb not null check(octet_length(configuration::text)<=131072),constraint_hash text not null check(constraint_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid not null,created_at timestamptz not null,
  primary key(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode) references public.sentinel_incident_state(organization_id,incident_id,mode)
);
create table public.sentinel_constraint_commands (
  organization_id uuid not null,incident_id uuid not null,mode text not null,actor_id uuid not null,command_id uuid not null,
  revision_id uuid not null,payload jsonb not null check(octet_length(payload::text)<=131072),receipt jsonb not null,
  primary key(organization_id,incident_id,mode,actor_id,command_id),
  foreign key(organization_id,incident_id,mode,revision_id) references public.sentinel_constraints(organization_id,incident_id,mode,id)
);
alter table public.sentinel_incident_state add foreign key(organization_id,incident_id,mode,current_constraint_revision)
  references public.sentinel_constraints(organization_id,incident_id,mode,id);
create trigger sentinel_constraints_immutable before update or delete on public.sentinel_constraints for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_constraint_commands_immutable before update or delete on public.sentinel_constraint_commands for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_constraints enable row level security;
alter table public.sentinel_constraint_commands enable row level security;
revoke all on table public.sentinel_constraints,public.sentinel_constraint_commands from public,anon,authenticated,service_role;

create function public.sentinel_constraint_instant(v jsonb) returns timestamptz language plpgsql immutable set search_path=pg_catalog as $$
declare result timestamptz;
begin
  if v='null'::jsonb then return null;end if;
  if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00(\.000)?Z$' then raise exception 'Invalid UTC minute' using errcode='22023';end if;
  result:=(v#>>'{}')::timestamptz;
  if to_char(result at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')<>replace(v#>>'{}','.000Z','Z') then raise exception 'Invalid UTC minute' using errcode='22023';end if;
  return result;
exception when data_exception then raise exception 'Invalid UTC minute' using errcode='22023';
end;
$$;
revoke all on function public.sentinel_constraint_instant(jsonb) from public,anon,authenticated,service_role;

create function public.sentinel_constraint_view(v public.sentinel_constraints) returns jsonb language sql stable set search_path=pg_catalog as $$
select jsonb_build_object('id',v.id,'scope',jsonb_build_object('organizationId',v.organization_id,'incidentId',v.incident_id,'mode',v.mode),
  'configuration',v.configuration,'constraintHash',v.constraint_hash,'createdBy',v.created_by,'createdAt',to_char(v.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
revoke all on function public.sentinel_constraint_view(public.sentinel_constraints) from public,anon,authenticated,service_role;

create function public.sentinel_record_constraints(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_command_id uuid,p_expected_revision uuid,p_configuration jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;prior public.sentinel_constraint_commands%rowtype;revision public.sentinel_constraints%rowtype;
  payload jsonb;receipt jsonb;item jsonb;crew_ids jsonb:='[]'::jsonb;task_ids jsonb:='[]'::jsonb;shift_start timestamptz;shift_end timestamptz;
  from_at timestamptz;until_at timestamptz;content_hash text;changed boolean;revision_id uuid;stamp timestamptz;key text;
begin
  if p_mode is null or p_mode not in ('live','replay','synthetic') or p_command_id is null or jsonb_typeof(p_configuration) is distinct from 'object'
    or octet_length(p_configuration::text)>131072 or (select count(*) from jsonb_object_keys(p_configuration))<>5
    or exists(select 1 from jsonb_object_keys(p_configuration) k where k not in ('schemaVersion','shift','crews','tasks','inputBasis'))
    or p_configuration->'schemaVersion' is distinct from '1'::jsonb or p_configuration->>'inputBasis' is null or p_configuration->>'inputBasis' not in ('user_authored','demo')
    or jsonb_typeof(p_configuration->'shift') is distinct from 'object' or (select count(*) from jsonb_object_keys(p_configuration->'shift'))<>2
    or not (p_configuration->'shift' ?& array['startsAt','endsAt'])
    or jsonb_typeof(p_configuration->'crews') is distinct from 'array' or jsonb_array_length(p_configuration->'crews')>2
    or jsonb_typeof(p_configuration->'tasks') is distinct from 'array' or jsonb_array_length(p_configuration->'tasks') not between 1 and 10
  then raise exception 'Invalid constraints' using errcode='22023';end if;
  shift_start:=public.sentinel_constraint_instant(p_configuration->'shift'->'startsAt');shift_end:=public.sentinel_constraint_instant(p_configuration->'shift'->'endsAt');
  if shift_start is null or shift_end is null or shift_end<=shift_start or shift_end-shift_start>interval '8 hours' then raise exception 'Invalid shift' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(p_configuration->'crews') loop
    if jsonb_typeof(item) is distinct from 'object' or (select count(*) from jsonb_object_keys(item))<>5
      or exists(select 1 from jsonb_object_keys(item) k where k not in ('id','label','capabilities','availableFrom','availableUntil'))
      or item->>'id' is null or item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'label') is distinct from 'string' or length(item->>'label') not between 1 and 100 or btrim(item->>'label')='' or crew_ids @> jsonb_build_array(item->>'id')
      or jsonb_typeof(item->'capabilities') not in ('array','null') then raise exception 'Invalid crew' using errcode='22023';end if;
    if jsonb_typeof(item->'capabilities')='array' then
      if jsonb_array_length(item->'capabilities')>20 or exists(select 1 from jsonb_array_elements(item->'capabilities') v where jsonb_typeof(v)<>'string' or (v#>>'{}') !~ '^[a-z][a-z0-9_-]{0,39}$')
        or (select count(distinct value) from jsonb_array_elements(item->'capabilities'))<>jsonb_array_length(item->'capabilities') then raise exception 'Invalid capabilities' using errcode='22023';end if;
    end if;
    from_at:=public.sentinel_constraint_instant(item->'availableFrom');until_at:=public.sentinel_constraint_instant(item->'availableUntil');
    if from_at is not null and until_at is not null and from_at>=until_at then raise exception 'Invalid crew interval' using errcode='22023';end if;
    crew_ids:=crew_ids||jsonb_build_array(item->>'id');
  end loop;
  perform 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Constraints unavailable' using errcode='42501';end if;
  perform 1 from public.incidents where organization_id=p_organization_id and id=p_incident_id for share;
  if not found then raise exception 'Constraints unavailable' using errcode='42501';end if;
  insert into public.sentinel_incident_state(organization_id,incident_id,mode) values(p_organization_id,p_incident_id,p_mode) on conflict do nothing;
  select * into state from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode for update;
  payload:=jsonb_build_object('expectedConstraintRevision',p_expected_revision,'configuration',p_configuration);
  select * into prior from public.sentinel_constraint_commands where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
  if found then
    if prior.payload<>payload then raise exception 'Constraint command changed' using errcode='40001';end if;
    select * into revision from public.sentinel_constraints where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=prior.revision_id;
    return jsonb_build_object('revision',public.sentinel_constraint_view(revision),'receipt',prior.receipt,'replayed',true);
  end if;
  if state.current_constraint_revision is distinct from p_expected_revision then raise exception 'Constraints changed' using errcode='40001';end if;
  for item in select value from jsonb_array_elements(p_configuration->'tasks') loop
    if jsonb_typeof(item) is distinct from 'object' or (select count(*) from jsonb_object_keys(item))<>10
      or exists(select 1 from jsonb_object_keys(item) k where k not in ('id','assetId','label','taskType','requiredCapability','durationMinutes','travelMinutes','windowFrom','windowUntil','priority'))
      or item->>'id' is null or item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or task_ids @> jsonb_build_array(item->>'id')
      or item->>'assetId' is null or item->>'assetId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'label') is distinct from 'string' or length(item->>'label') not between 1 and 100 or btrim(item->>'label')=''
      or jsonb_typeof(item->'taskType') is distinct from 'string' or item->>'taskType' !~ '^[a-z][a-z0-9_-]{0,39}$'
      or jsonb_typeof(item->'requiredCapability') not in ('string','null') or (item->>'requiredCapability' is not null and item->>'requiredCapability' !~ '^[a-z][a-z0-9_-]{0,39}$')
      or jsonb_typeof(item->'priority') is distinct from 'number' or item->>'priority' !~ '^([1-9]|10)$' then raise exception 'Invalid task' using errcode='22023';end if;
    for key in select unnest(array['durationMinutes','travelMinutes']) loop
      if jsonb_typeof(item->key) not in ('number','null') or (item->>key is not null and ((item->>key) !~ '^[0-9]{1,3}$' or (item->>key)::int>480 or (key='durationMinutes' and (item->>key)::int=0))) then raise exception 'Invalid estimate' using errcode='22023';end if;
    end loop;
    from_at:=public.sentinel_constraint_instant(item->'windowFrom');until_at:=public.sentinel_constraint_instant(item->'windowUntil');
    if from_at is not null and until_at is not null and from_at>=until_at then raise exception 'Invalid task interval' using errcode='22023';end if;
    perform 1 from public.assets where id=(item->>'assetId')::uuid and incident_id=p_incident_id for share;
    if not found then raise exception 'Task asset unavailable' using errcode='42501';end if;
    task_ids:=task_ids||jsonb_build_array(item->>'id');
  end loop;
  content_hash:=encode(sha256(convert_to(p_configuration::text,'UTF8')),'hex');
  select * into revision from public.sentinel_constraints where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=state.current_constraint_revision;
  changed:=revision.id is null or revision.constraint_hash<>content_hash;stamp:=clock_timestamp();
  if changed then
    if state.evidence_generation>=9007199254740991 then raise exception 'Generation exhausted' using errcode='40001';end if;
    revision_id:=gen_random_uuid();
    insert into public.sentinel_constraints values(p_organization_id,p_incident_id,p_mode,revision_id,p_configuration,content_hash,p_actor_id,stamp) returning * into revision;
    update public.sentinel_incident_state set current_constraint_revision=revision_id,evidence_generation=evidence_generation+1
      where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode returning * into state;
  end if;
  receipt:=jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'commandId',p_command_id,
    'actorId',p_actor_id,'revisionId',revision.id,'previousRevisionId',p_expected_revision,'changed',changed,'committedAt',to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'evidenceGeneration',state.evidence_generation,'unresolvedSourceChanges',state.unresolved_source_change_count);
  insert into public.sentinel_constraint_commands values(p_organization_id,p_incident_id,p_mode,p_actor_id,p_command_id,revision.id,payload,receipt);
  return jsonb_build_object('revision',public.sentinel_constraint_view(revision),'receipt',receipt,'replayed',false);
exception when data_exception then raise exception 'Invalid constraint value' using errcode='22023';
end;
$$;
revoke all on function public.sentinel_record_constraints(uuid,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sentinel_record_constraints(uuid,uuid,uuid,text,uuid,uuid,jsonb) to service_role;

create function public.sentinel_read_constraints(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state public.sentinel_incident_state%rowtype;revision public.sentinel_constraints%rowtype;
begin
  state:=public.sentinel_lock_evidence_reader(p_actor_id,p_organization_id,p_incident_id,p_mode);if state.organization_id is null then return null;end if;
  select * into revision from public.sentinel_constraints where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=state.current_constraint_revision;
  return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),
    'revision',case when revision.id is null then null else public.sentinel_constraint_view(revision) end,'evidenceGeneration',state.evidence_generation,
    'unresolvedSourceChanges',state.unresolved_source_change_count,'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;
revoke all on function public.sentinel_read_constraints(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.sentinel_read_constraints(uuid,uuid,uuid,text) to service_role;
commit;
