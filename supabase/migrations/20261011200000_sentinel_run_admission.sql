-- Sentinel-only durable execution foundation. No provider call or completed result is synthesized.
begin;

create table public.sentinel_org_runtime (
  organization_id uuid primary key references public.organizations(id)
);
create table public.sentinel_runs (
  id uuid not null default gen_random_uuid(), organization_id uuid not null, incident_id uuid not null, mode text not null,
  source_config_revision uuid not null, created_by uuid not null,
  created_at timestamptz not null, deadline_at timestamptz not null, dispatch_id uuid not null,
  status text not null default 'queued' check(status in ('queued','retrieving','interpreting','validating','ready_for_review','completed','canceled','failed','budget_stopped')),
  stage text not null default 'admitted' check(stage ~ '^[a-z0-9_-]{1,80}$'),
  fence bigint not null default 0 check(fence >= 0), lease_owner uuid, lease_until timestamptz,
  tavily_requests integer not null default 0 check(tavily_requests between 0 and 4),
  model_requests integer not null default 0 check(model_requests between 0 and 8),
  input_tokens integer not null default 0 check(input_tokens between 0 and 24000),
  output_tokens integer not null default 0 check(output_tokens between 0 and 6000),
  primary key(organization_id,incident_id,mode,id),
  unique(dispatch_id), check(dispatch_id=id), check(deadline_at=created_at+interval '120 seconds'),
  check((lease_owner is null)=(lease_until is null)), check(lease_until is null or lease_until<=deadline_at),
  foreign key(organization_id,incident_id,mode,source_config_revision)
    references public.sentinel_source_configs(organization_id,incident_id,mode,id)
);
create unique index sentinel_one_active_run_per_incident on public.sentinel_runs(organization_id,incident_id)
  where status in ('queued','retrieving','interpreting','validating','ready_for_review');
create table public.sentinel_run_commands (
  id uuid not null default gen_random_uuid(), organization_id uuid not null, incident_id uuid not null, mode text not null,
  actor_id uuid not null, command_id uuid not null, kind text not null check(kind in ('admit','cancel')),
  payload jsonb not null, receipt jsonb not null, run_id uuid not null,
  primary key(organization_id,incident_id,mode,id), unique(organization_id,incident_id,mode,actor_id,command_id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
create table public.sentinel_provider_reservations (
  id uuid not null, organization_id uuid not null, incident_id uuid not null, mode text not null, run_id uuid not null,
  fence bigint not null, stage text not null check(stage ~ '^[a-z0-9_-]{1,80}$'), kind text not null check(kind in ('tavily','model')),
  input_tokens integer not null check(input_tokens between 0 and 24000),
  output_tokens integer not null check(output_tokens between 0 and 1000),
  reserved_at timestamptz not null, dispatch_deadline timestamptz not null,
  state text not null default 'reserved' check(state in ('reserved','completed','uncertain')),
  actual_input_tokens integer, actual_output_tokens integer, response_bytes integer,
  primary key(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id),
  check(dispatch_deadline>reserved_at), check(kind='model' or (input_tokens=0 and output_tokens=0)),
  check(actual_input_tokens is null or actual_input_tokens between 0 and input_tokens),
  check(actual_output_tokens is null or actual_output_tokens between 0 and output_tokens),
  check(response_bytes is null or response_bytes between 0 and 1048576),
  check((state='completed')=(actual_input_tokens is not null and actual_output_tokens is not null and response_bytes is not null))
);
create table public.sentinel_run_checkpoints (
  id uuid not null, organization_id uuid not null, incident_id uuid not null, mode text not null, run_id uuid not null,
  fence bigint not null, state text not null check(state in ('retrieving','interpreting','validating')),
  stage text not null check(stage ~ '^[a-z0-9_-]{1,80}$'), result_hash text not null check(result_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,run_id) references public.sentinel_runs(organization_id,incident_id,mode,id)
);
create trigger sentinel_run_commands_immutable before update or delete on public.sentinel_run_commands
  for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_run_checkpoints_immutable before update or delete on public.sentinel_run_checkpoints
  for each row execute function public.sentinel_reject_evidence_mutation();
alter table public.sentinel_org_runtime enable row level security;
alter table public.sentinel_runs enable row level security;
alter table public.sentinel_run_commands enable row level security;
alter table public.sentinel_provider_reservations enable row level security;
alter table public.sentinel_run_checkpoints enable row level security;
revoke all on table public.sentinel_org_runtime,public.sentinel_runs,public.sentinel_run_commands,
  public.sentinel_provider_reservations,public.sentinel_run_checkpoints from public,anon,authenticated,service_role;

-- Safe scoped projection; lease-owner nonce and reservation internals never enter viewer reads.
create function public.sentinel_run_view(r public.sentinel_runs) returns jsonb
language sql stable set search_path=pg_catalog as $$
  select jsonb_build_object('id',r.id,'scope',jsonb_build_object('organizationId',r.organization_id,'incidentId',r.incident_id,'mode',r.mode),
    'sourceConfigRevision',r.source_config_revision,'createdBy',r.created_by,'dispatchId',r.dispatch_id,
    'createdAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'deadlineAt',to_char(r.deadline_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'status',r.status,'stage',r.stage,'fence',r.fence,
    'leaseUntil',case when r.lease_until is null then null else to_char(r.lease_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'usage',jsonb_build_object('tavilyRequests',r.tavily_requests,'modelRequests',r.model_requests,'inputTokens',r.input_tokens,'outputTokens',r.output_tokens));
$$;
revoke all on function public.sentinel_run_view(public.sentinel_runs) from public,anon,authenticated,service_role;

-- Execution lock order: membership SHARE -> org execution row -> incident state -> run.
-- All new execution writers use this order. Provider requests never hold these locks.
create function public.sentinel_lock_execution(p_actor uuid,p_org uuid,p_incident uuid,p_mode text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform 1 from public.organization_members where organization_id=p_org and user_id=p_actor
    and role in ('analyst','incident_commander') for share;
  if not found then raise exception 'Run unavailable' using errcode='42501'; end if;
  insert into public.sentinel_org_runtime(organization_id) values(p_org) on conflict do nothing;
  perform 1 from public.sentinel_org_runtime where organization_id=p_org for update;
  perform 1 from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident and mode=p_mode for update;
  if not found then raise exception 'Run unavailable' using errcode='42501'; end if;
end;
$$;
revoke all on function public.sentinel_lock_execution(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.sentinel_admit_run(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_config_id uuid,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype; c public.sentinel_run_commands%rowtype; payload jsonb; now_at timestamptz; run_id uuid;
begin
  if p_command_id is null or p_config_id is null then raise exception 'Invalid command' using errcode='22023'; end if;
  perform public.sentinel_lock_execution(p_actor_id,p_organization_id,p_incident_id,p_mode);
  payload:=jsonb_build_object('kind','admit','sourceConfigRevision',p_config_id);
  select * into c from public.sentinel_run_commands where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
  if found then
    if c.payload<>payload then raise exception 'Command conflict' using errcode='23505'; end if;
    select * into r from public.sentinel_runs where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=c.run_id;
    return jsonb_build_object('run',public.sentinel_run_view(r),'receipt',c.receipt,'replayed',true);
  end if;
  if not exists(select 1 from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and current_source_config_revision=p_config_id) then raise exception 'Configuration changed' using errcode='40001'; end if;
  now_at:=date_trunc('milliseconds',clock_timestamp());
  update public.sentinel_runs set status='failed',stage='deadline_expired',fence=fence+1,lease_owner=null,lease_until=null
    where organization_id=p_organization_id and incident_id=p_incident_id and deadline_at<=now_at
      and status in ('queued','retrieving','interpreting','validating','ready_for_review');
  if exists(select 1 from public.sentinel_runs where organization_id=p_organization_id and incident_id=p_incident_id
    and status in ('queued','retrieving','interpreting','validating','ready_for_review')) then raise exception 'Run already active' using errcode='55P03'; end if;
  run_id:=gen_random_uuid();
  insert into public.sentinel_runs(id,organization_id,incident_id,mode,source_config_revision,created_by,created_at,deadline_at,dispatch_id)
    values(run_id,p_organization_id,p_incident_id,p_mode,p_config_id,p_actor_id,now_at,now_at+interval '120 seconds',run_id) returning * into r;
  insert into public.sentinel_run_commands(organization_id,incident_id,mode,actor_id,command_id,kind,payload,receipt,run_id)
    values(p_organization_id,p_incident_id,p_mode,p_actor_id,p_command_id,'admit',payload,
      jsonb_build_object('runId',run_id,'commandId',p_command_id,'kind','admit','status','queued','at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),run_id) returning * into c;
  return jsonb_build_object('run',public.sentinel_run_view(r),'receipt',c.receipt,'replayed',false);
end;
$$;
revoke all on function public.sentinel_admit_run(uuid,uuid,uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_admit_run(uuid,uuid,uuid,text,uuid,uuid) to service_role;

create function public.sentinel_read_run(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;
begin
  perform 1 from public.organization_members where user_id=p_actor_id and organization_id=p_organization_id
    and role in ('viewer','analyst','incident_commander') for share;
  if not found then raise exception 'Run unavailable' using errcode='42501'; end if;
  select * into r from public.sentinel_runs where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_run_id;
  if not found then return null; end if;
  return public.sentinel_run_view(r);
end;
$$;
revoke all on function public.sentinel_read_run(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_run(uuid,uuid,uuid,text,uuid) to service_role;

-- Worker actor is read from the persisted run, never from a queued/model request body.
create function public.sentinel_lock_worker_run(p_org uuid,p_incident uuid,p_mode text,p_run uuid)
returns public.sentinel_runs language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;
begin
  select * into r from public.sentinel_runs where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=p_run;
  if not found then raise exception 'Run unavailable' using errcode='42501'; end if;
  perform public.sentinel_lock_execution(r.created_by,p_org,p_incident,p_mode);
  select * into r from public.sentinel_runs where organization_id=p_org and incident_id=p_incident and mode=p_mode and id=p_run for update;
  if not exists(select 1 from public.sentinel_incident_state where organization_id=p_org and incident_id=p_incident
    and mode=p_mode and current_source_config_revision=r.source_config_revision) then raise exception 'Configuration changed' using errcode='40001'; end if;
  return r;
end;
$$;
revoke all on function public.sentinel_lock_worker_run(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;

create function public.sentinel_assert_lease(r public.sentinel_runs,p_owner uuid,p_fence bigint,p_now timestamptz)
returns void language plpgsql set search_path=pg_catalog as $$
begin
  if p_owner is null or p_fence is null or r.lease_owner is distinct from p_owner or r.fence<>p_fence
    or r.lease_until is null or r.lease_until<=p_now or r.deadline_at<=p_now
    or r.status not in ('retrieving','interpreting','validating') then raise exception 'Lease no longer current' using errcode='40001'; end if;
end;
$$;
revoke all on function public.sentinel_assert_lease(public.sentinel_runs,uuid,bigint,timestamptz) from public,anon,authenticated,service_role;

create function public.sentinel_acquire_run_lease(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,p_owner uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype; now_at timestamptz;
begin
  if p_owner is null then raise exception 'Invalid worker' using errcode='22023'; end if;
  r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
  now_at:=date_trunc('milliseconds',clock_timestamp());
  if r.deadline_at<=now_at or r.status not in ('queued','retrieving','interpreting','validating') then raise exception 'Run no longer active' using errcode='40001'; end if;
  if r.lease_until>now_at then
    if r.lease_owner<>p_owner then raise exception 'Worker already active' using errcode='55P03'; end if;
  else
    update public.sentinel_runs set lease_owner=p_owner,lease_until=least(deadline_at,now_at+interval '30 seconds'),fence=fence+1,
      status=case when status='queued' then 'retrieving' else status end,
      stage=case when status='queued' then 'acquired' else stage end
      where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_run_id returning * into r;
  end if;
  return jsonb_build_object('run',public.sentinel_run_view(r),'owner',r.lease_owner);
end;
$$;
revoke all on function public.sentinel_acquire_run_lease(uuid,uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_acquire_run_lease(uuid,uuid,text,uuid,uuid) to service_role;

create function public.sentinel_renew_run_lease(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,p_owner uuid,p_fence bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype; now_at timestamptz;
begin
  r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
  now_at:=date_trunc('milliseconds',clock_timestamp());
  perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
  update public.sentinel_runs set lease_until=least(deadline_at,greatest(lease_until,now_at+interval '30 seconds'))
    where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_run_id returning * into r;
  return jsonb_build_object('run',public.sentinel_run_view(r),'owner',r.lease_owner);
end;
$$;
revoke all on function public.sentinel_renew_run_lease(uuid,uuid,text,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.sentinel_renew_run_lease(uuid,uuid,text,uuid,uuid,bigint) to service_role;

create function public.sentinel_reserve_provider_attempt(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,
  p_owner uuid,p_fence bigint,p_attempt_id uuid,p_stage text,p_kind text,p_input_tokens integer,p_output_tokens integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype; a public.sentinel_provider_reservations%rowtype; now_at timestamptz;
begin
  if p_attempt_id is null or p_stage is null or p_stage !~ '^[a-z0-9_-]{1,80}$' or p_kind is null or p_kind not in ('model','tavily')
    or p_input_tokens is null or p_input_tokens<0 or p_input_tokens>24000 or p_output_tokens is null or p_output_tokens<0 or p_output_tokens>1000
    or (p_kind='tavily' and (p_input_tokens<>0 or p_output_tokens<>0)) then raise exception 'Invalid reservation' using errcode='22023'; end if;
  r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
  now_at:=date_trunc('milliseconds',clock_timestamp());
  perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
  if not exists(select 1 from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id
    and mode=p_mode and current_source_config_revision=r.source_config_revision) then raise exception 'Configuration changed' using errcode='40001'; end if;
  select * into a from public.sentinel_provider_reservations where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_attempt_id;
  if found then
    if a.run_id<>p_run_id or a.fence<>p_fence or a.stage<>p_stage or a.kind<>p_kind or a.input_tokens<>p_input_tokens or a.output_tokens<>p_output_tokens then
      raise exception 'Attempt conflict' using errcode='23505'; end if;
    -- Never redispatch an existing attempt, even if no response/checkpoint was saved.
    return jsonb_build_object('attemptId',a.id,'dispatchAllowed',false,'dispatchDeadline',to_char(a.dispatch_deadline at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  end if;
  if (select count(*) from public.sentinel_provider_reservations where organization_id=p_organization_id
      and state<>'completed' and dispatch_deadline>now_at)>=2 then raise exception 'Provider capacity unavailable' using errcode='55P03'; end if;
  if r.tavily_requests+(case when p_kind='tavily' then 1 else 0 end)>4 or r.model_requests+(case when p_kind='model' then 1 else 0 end)>8
    or r.input_tokens+p_input_tokens>24000 or r.output_tokens+p_output_tokens>6000 then raise exception 'Run budget exhausted' using errcode='54000'; end if;
  insert into public.sentinel_provider_reservations(id,organization_id,incident_id,mode,run_id,fence,stage,kind,input_tokens,output_tokens,reserved_at,dispatch_deadline)
    values(p_attempt_id,p_organization_id,p_incident_id,p_mode,p_run_id,p_fence,p_stage,p_kind,p_input_tokens,p_output_tokens,now_at,least(r.deadline_at,r.lease_until)) returning * into a;
  update public.sentinel_runs set tavily_requests=tavily_requests+case when p_kind='tavily' then 1 else 0 end,
    model_requests=model_requests+case when p_kind='model' then 1 else 0 end,input_tokens=input_tokens+p_input_tokens,output_tokens=output_tokens+p_output_tokens
    where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_run_id;
  return jsonb_build_object('attemptId',a.id,'dispatchAllowed',true,'dispatchDeadline',to_char(a.dispatch_deadline at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;
revoke all on function public.sentinel_reserve_provider_attempt(uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.sentinel_reserve_provider_attempt(uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,integer,integer) to service_role;

create function public.sentinel_settle_provider_attempt(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,
  p_owner uuid,p_fence bigint,p_attempt_id uuid,p_state text,p_input_tokens integer,p_output_tokens integer,p_response_bytes integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype; a public.sentinel_provider_reservations%rowtype; now_at timestamptz;
begin
  r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
  now_at:=date_trunc('milliseconds',clock_timestamp());
  perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
  select * into a from public.sentinel_provider_reservations where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_attempt_id for update;
  if not found or a.run_id<>p_run_id or a.fence<>p_fence then raise exception 'Attempt unavailable' using errcode='42501'; end if;
  if p_state is null or p_state not in ('completed','uncertain') or
    (p_state='completed' and (p_input_tokens is null or p_output_tokens is null or p_response_bytes is null or
      p_input_tokens<0 or p_input_tokens>a.input_tokens or p_output_tokens<0 or p_output_tokens>a.output_tokens or p_response_bytes<0 or p_response_bytes>1048576)) or
    (p_state='uncertain' and (p_input_tokens is not null or p_output_tokens is not null or p_response_bytes is not null)) then raise exception 'Invalid usage' using errcode='22023'; end if;
  if a.state<>'reserved' then
    if a.state<>p_state or a.actual_input_tokens is distinct from p_input_tokens or a.actual_output_tokens is distinct from p_output_tokens
      or a.response_bytes is distinct from p_response_bytes then raise exception 'Usage conflict' using errcode='23505'; end if;
  else
    if a.dispatch_deadline<=now_at then raise exception 'Attempt deadline expired' using errcode='40001'; end if;
    update public.sentinel_provider_reservations set state=p_state,actual_input_tokens=p_input_tokens,actual_output_tokens=p_output_tokens,response_bytes=p_response_bytes
      where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_attempt_id returning * into a;
  end if;
  -- Reservations remain charged conservatively; settlement never refunds or resets the run's ceiling.
  return jsonb_build_object('attemptId',a.id,'state',a.state);
end;
$$;
revoke all on function public.sentinel_settle_provider_attempt(uuid,uuid,text,uuid,uuid,bigint,uuid,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.sentinel_settle_provider_attempt(uuid,uuid,text,uuid,uuid,bigint,uuid,text,integer,integer,integer) to service_role;

create function public.sentinel_checkpoint_run(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,
  p_owner uuid,p_fence bigint,p_checkpoint_id uuid,p_state text,p_stage text,p_result_hash text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype; c public.sentinel_run_checkpoints%rowtype; now_at timestamptz;
begin
  if p_checkpoint_id is null or p_stage is null or p_stage !~ '^[a-z0-9_-]{1,80}$' or p_result_hash is null or p_result_hash !~ '^[a-f0-9]{64}$'
    or p_state is null or p_state not in ('retrieving','interpreting','validating') then raise exception 'Invalid checkpoint' using errcode='22023'; end if;
  r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
  now_at:=date_trunc('milliseconds',clock_timestamp());
  perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
  select * into c from public.sentinel_run_checkpoints where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_checkpoint_id;
  if found then
    if c.run_id<>p_run_id or c.fence<>p_fence or c.state<>p_state or c.stage<>p_stage or c.result_hash<>p_result_hash then
      raise exception 'Checkpoint conflict' using errcode='23505'; end if;
    return public.sentinel_run_view(r);
  end if;
  if not (r.status=p_state or (r.status='retrieving' and p_state='interpreting') or (r.status='interpreting' and p_state='validating')) then
    raise exception 'Invalid stage transition' using errcode='40001'; end if;
  insert into public.sentinel_run_checkpoints(id,organization_id,incident_id,mode,run_id,fence,state,stage,result_hash)
    values(p_checkpoint_id,p_organization_id,p_incident_id,p_mode,p_run_id,p_fence,p_state,p_stage,p_result_hash);
  update public.sentinel_runs set status=p_state,stage=p_stage where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_run_id returning * into r;
  return public.sentinel_run_view(r);
end;
$$;
revoke all on function public.sentinel_checkpoint_run(uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.sentinel_checkpoint_run(uuid,uuid,text,uuid,uuid,bigint,uuid,text,text,text) to service_role;

create function public.sentinel_cancel_run(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype; c public.sentinel_run_commands%rowtype; payload jsonb; now_at timestamptz;
begin
  if p_command_id is null then raise exception 'Invalid command' using errcode='22023'; end if;
  perform public.sentinel_lock_execution(p_actor_id,p_organization_id,p_incident_id,p_mode);
  select * into r from public.sentinel_runs where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_run_id for update;
  if not found then raise exception 'Run unavailable' using errcode='42501'; end if;
  if r.created_by<>p_actor_id and not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=p_actor_id and role='incident_commander') then
    raise exception 'Run unavailable' using errcode='42501'; end if;
  payload:=jsonb_build_object('kind','cancel','runId',p_run_id);
  select * into c from public.sentinel_run_commands where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and actor_id=p_actor_id and command_id=p_command_id;
  if found then
    if c.payload<>payload then raise exception 'Command conflict' using errcode='23505'; end if;
    return jsonb_build_object('run',public.sentinel_run_view(r),'receipt',c.receipt,'replayed',true);
  end if;
  now_at:=date_trunc('milliseconds',clock_timestamp());
  if r.status in ('queued','retrieving','interpreting','validating','ready_for_review') then
    update public.sentinel_runs set status='canceled',stage='canceled',fence=fence+1,lease_owner=null,lease_until=null
      where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=p_run_id returning * into r;
  end if;
  insert into public.sentinel_run_commands(organization_id,incident_id,mode,actor_id,command_id,kind,payload,receipt,run_id)
    values(p_organization_id,p_incident_id,p_mode,p_actor_id,p_command_id,'cancel',payload,
      jsonb_build_object('runId',r.id,'commandId',p_command_id,'kind','cancel','status',r.status,'at',to_char(now_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),r.id) returning * into c;
  return jsonb_build_object('run',public.sentinel_run_view(r),'receipt',c.receipt,'replayed',false);
end;
$$;
revoke all on function public.sentinel_cancel_run(uuid,uuid,uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_cancel_run(uuid,uuid,uuid,text,uuid,uuid) to service_role;

commit;
