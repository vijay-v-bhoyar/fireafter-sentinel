-- Owner-managed account qualification. Runtime has no pricing/funding table writes.
create table public.sentinel_provider_prices (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 provider text not null check(provider in ('tavily','nebius')),operation text not null check(operation in ('search','extract','extract_claims','compare_claims')),
 model_id text,request_micro_usd bigint not null check(request_micro_usd between 0 and 1000000000000),
 input_micro_usd_per_million bigint not null check(input_micro_usd_per_million between 0 and 1000000000000),
 output_micro_usd_per_million bigint not null check(output_micro_usd_per_million between 0 and 1000000000000),
 request_units bigint not null check(request_units between 0 and 1000000000000),
 authority_evidence_hash text not null check(authority_evidence_hash ~ '^[a-f0-9]{64}$'),
 valid_from timestamptz not null,valid_until timestamptz not null,created_at timestamptz not null default clock_timestamp(),
 check(isfinite(valid_from) and isfinite(valid_until) and valid_until>valid_from),
 check((provider='tavily' and operation in ('search','extract') and model_id is null and input_micro_usd_per_million=0 and output_micro_usd_per_million=0 and request_units>0)
 or(provider='nebius' and operation in ('extract_claims','compare_claims') and model_id is not null and model_id ~ '^nvidia/[A-Za-z0-9._/-]{1,150}$' and request_units=0)),
 unique(organization_id,id)
);
create table public.sentinel_provider_funds (
 organization_id uuid not null references public.organizations(id),provider text not null check(provider in ('tavily','nebius')),
 ceiling_micro_usd bigint not null check(ceiling_micro_usd between 0 and 1000000000000),
 ceiling_units bigint not null check(ceiling_units between 1 and 1000000000000),
 reserved_micro_usd bigint not null default 0 check(reserved_micro_usd between 0 and ceiling_micro_usd),
 reserved_units bigint not null default 0 check(reserved_units between 0 and ceiling_units),
 authority_evidence_hash text not null check(authority_evidence_hash ~ '^[a-f0-9]{64}$'),
 primary key(organization_id,provider)
);
create table public.sentinel_priced_reservations (
 organization_id uuid not null,incident_id uuid not null,mode text not null,attempt_id uuid not null,run_id uuid not null,
 provider text not null,operation text not null,price_id uuid not null,
 reserved_micro_usd bigint not null check(reserved_micro_usd between 0 and 1000000000000),
 reserved_units bigint not null check(reserved_units between 1 and 1000000000000),created_at timestamptz not null default clock_timestamp(),
 primary key(organization_id,incident_id,mode,attempt_id),
 foreign key(organization_id,incident_id,mode,attempt_id) references public.sentinel_provider_reservations(organization_id,incident_id,mode,id),
 foreign key(organization_id,price_id) references public.sentinel_provider_prices(organization_id,id),
 foreign key(organization_id,provider) references public.sentinel_provider_funds(organization_id,provider)
);
create trigger sentinel_provider_prices_immutable before update or delete on public.sentinel_provider_prices
 for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_priced_reservations_immutable before update or delete on public.sentinel_priced_reservations
 for each row execute function public.sentinel_reject_evidence_mutation();
create function public.sentinel_preserve_provider_funds() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='DELETE' then raise exception 'Provider funding history is retained' using errcode='42501';end if;
 if new.organization_id<>old.organization_id or new.provider<>old.provider or new.reserved_micro_usd<old.reserved_micro_usd or new.reserved_units<old.reserved_units then
  raise exception 'Provider usage cannot be reset or refunded' using errcode='42501';end if;
 return new;
end;$$;
create trigger sentinel_provider_funds_monotonic before update or delete on public.sentinel_provider_funds
 for each row execute function public.sentinel_preserve_provider_funds();
revoke all on function public.sentinel_preserve_provider_funds() from public,anon,authenticated,service_role;
alter table public.sentinel_provider_prices enable row level security;
alter table public.sentinel_provider_funds enable row level security;
alter table public.sentinel_priced_reservations enable row level security;
revoke all on table public.sentinel_provider_prices,public.sentinel_provider_funds,public.sentinel_priced_reservations from public,anon,authenticated,service_role;

create function public.sentinel_provider_price_view(p public.sentinel_provider_prices) returns jsonb
language sql stable set search_path=pg_catalog as $$
 select jsonb_build_object('id',p.id,'organizationId',p.organization_id,'provider',p.provider,'operation',p.operation,'modelId',p.model_id,
 'requestMicroUsd',p.request_micro_usd,'inputMicroUsdPerMillion',p.input_micro_usd_per_million,'outputMicroUsdPerMillion',p.output_micro_usd_per_million,
 'requestUnits',p.request_units,'authorityEvidenceHash',p.authority_evidence_hash,
 'validFrom',to_char(p.valid_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'validUntil',to_char(p.valid_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
revoke all on function public.sentinel_provider_price_view(public.sentinel_provider_prices) from public,anon,authenticated,service_role;

create function public.sentinel_read_provider_price(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,p_owner uuid,p_fence bigint,
 p_provider text,p_operation text,p_model_id text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;price public.sentinel_provider_prices%rowtype;now_at timestamptz;
begin
 r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
 now_at:=clock_timestamp();perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
 select * into price from public.sentinel_provider_prices where organization_id=p_organization_id and provider=p_provider and operation=p_operation
  and model_id is not distinct from p_model_id and valid_from<=now_at and valid_until>now_at order by valid_from desc,created_at desc,id desc limit 1;
 if not found or not exists(select 1 from public.sentinel_provider_funds where organization_id=p_organization_id and provider=p_provider) then return null;end if;
 return public.sentinel_provider_price_view(price);
end;$$;
revoke all on function public.sentinel_read_provider_price(uuid,uuid,text,uuid,uuid,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.sentinel_read_provider_price(uuid,uuid,text,uuid,uuid,bigint,text,text,text) to service_role;

create function public.sentinel_read_provider_sources(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,p_owner uuid,p_fence bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;cfg public.sentinel_source_configs%rowtype;
begin
 r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
 perform public.sentinel_assert_lease(r,p_owner,p_fence,clock_timestamp());
 if not exists(select 1 from public.sentinel_incident_state where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and current_source_config_revision=r.source_config_revision) then
  raise exception 'Source configuration changed' using errcode='40001';end if;
 select * into cfg from public.sentinel_source_configs where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and id=r.source_config_revision;
 if not found then raise exception 'Source registry unavailable' using errcode='42501';end if;
 return jsonb_build_object('scope',jsonb_build_object('organizationId',p_organization_id,'incidentId',p_incident_id,'mode',p_mode),'runId',r.id,
  'sourceConfigRevision',cfg.id,'configuration',cfg.configuration);
end;$$;
revoke all on function public.sentinel_read_provider_sources(uuid,uuid,text,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.sentinel_read_provider_sources(uuid,uuid,text,uuid,uuid,bigint) to service_role;

create function public.sentinel_reserve_priced_provider_attempt(p_organization_id uuid,p_incident_id uuid,p_mode text,p_run_id uuid,p_owner uuid,p_fence bigint,
 p_attempt_id uuid,p_stage text,p_price_id uuid,p_input_tokens integer,p_output_tokens integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;price public.sentinel_provider_prices%rowtype;funds public.sentinel_provider_funds%rowtype;
 hold public.sentinel_priced_reservations%rowtype;reservation jsonb;cost bigint;units bigint;now_at timestamptz;
begin
 r:=public.sentinel_lock_worker_run(p_organization_id,p_incident_id,p_mode,p_run_id);
 now_at:=clock_timestamp();perform public.sentinel_assert_lease(r,p_owner,p_fence,now_at);
 select * into price from public.sentinel_provider_prices where organization_id=p_organization_id and id=p_price_id;
 if not found then raise exception 'Qualified provider price unavailable' using errcode='42501';end if;
 if p_input_tokens is null or p_output_tokens is null or p_input_tokens<0 or p_input_tokens>24000 or p_output_tokens<0 or p_output_tokens>1000
  or(price.provider='tavily' and (p_input_tokens<>0 or p_output_tokens<>0)) or(price.provider='nebius' and p_output_tokens=0) then
  raise exception 'Invalid priced reservation' using errcode='22023';end if;
 -- The existing execution lock order and original attempt key remain authoritative.
 select * into hold from public.sentinel_priced_reservations where organization_id=p_organization_id and incident_id=p_incident_id and mode=p_mode and attempt_id=p_attempt_id;
 if found then
  if hold.run_id<>p_run_id or hold.price_id<>p_price_id then raise exception 'Priced attempt conflict' using errcode='23505';end if;
  reservation:=public.sentinel_reserve_provider_attempt(p_organization_id,p_incident_id,p_mode,p_run_id,p_owner,p_fence,p_attempt_id,p_stage,
   case when price.provider='tavily' then 'tavily' else 'model' end,p_input_tokens,p_output_tokens);
  return reservation||jsonb_build_object('priceId',price.id,'reservedMicroUsd',hold.reserved_micro_usd,'reservedUnits',hold.reserved_units);
 end if;
 if price.valid_from>now_at or price.valid_until<=now_at then raise exception 'Provider price qualification expired' using errcode='40001';end if;
 select * into funds from public.sentinel_provider_funds where organization_id=p_organization_id and provider=price.provider for update;
 if not found then raise exception 'Provider funding unavailable' using errcode='42501';end if;
 now_at:=clock_timestamp();
 if price.valid_from>now_at or price.valid_until<=now_at then raise exception 'Provider price qualification expired' using errcode='40001';end if;
 cost:=price.request_micro_usd+(price.input_micro_usd_per_million*p_input_tokens+999999)/1000000+(price.output_micro_usd_per_million*p_output_tokens+999999)/1000000;
 units:=case when price.provider='tavily' then price.request_units else p_input_tokens+p_output_tokens end;
 if funds.reserved_micro_usd+cost>funds.ceiling_micro_usd or funds.reserved_units+units>funds.ceiling_units then raise exception 'Provider account ceiling exhausted' using errcode='54000';end if;
 reservation:=public.sentinel_reserve_provider_attempt(p_organization_id,p_incident_id,p_mode,p_run_id,p_owner,p_fence,p_attempt_id,p_stage,
  case when price.provider='tavily' then 'tavily' else 'model' end,p_input_tokens,p_output_tokens);
 if (reservation->>'dispatchAllowed')::boolean is not true then raise exception 'Unpriced attempt cannot dispatch' using errcode='40001';end if;
 insert into public.sentinel_priced_reservations(organization_id,incident_id,mode,attempt_id,run_id,provider,operation,price_id,reserved_micro_usd,reserved_units)
  values(p_organization_id,p_incident_id,p_mode,p_attempt_id,p_run_id,price.provider,price.operation,price.id,cost,units);
 update public.sentinel_provider_funds set reserved_micro_usd=reserved_micro_usd+cost,reserved_units=reserved_units+units
  where organization_id=p_organization_id and provider=price.provider;
 perform public.sentinel_assert_lease(r,p_owner,p_fence,clock_timestamp());
 if price.valid_until<=clock_timestamp() then raise exception 'Provider price qualification expired' using errcode='40001';end if;
 return reservation||jsonb_build_object('priceId',price.id,'reservedMicroUsd',cost,'reservedUnits',units);
end;$$;
revoke all on function public.sentinel_reserve_priced_provider_attempt(uuid,uuid,text,uuid,uuid,bigint,uuid,text,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.sentinel_reserve_priced_provider_attempt(uuid,uuid,text,uuid,uuid,bigint,uuid,text,uuid,integer,integer) to service_role;
