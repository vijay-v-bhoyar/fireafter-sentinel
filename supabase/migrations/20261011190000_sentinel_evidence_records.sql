-- Sentinel only: apply to a fresh admitted target after the inherited migration chain.
-- This slice exposes scoped reads. Publication/generation commands follow durable-run admission.
begin;

create unique index if not exists sentinel_incident_organization_key on public.incidents(organization_id,id);

create table public.sentinel_incident_state (
  organization_id uuid not null, incident_id uuid not null,
  mode text not null check(mode in ('live','replay','synthetic')),
  evidence_generation bigint not null default 0 check(evidence_generation >= 0),
  unresolved_source_change_count integer not null default 0 check(unresolved_source_change_count >= 0),
  current_source_config_revision uuid, current_constraint_revision uuid,
  created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,incident_id,mode),
  foreign key(organization_id,incident_id) references public.incidents(organization_id,id)
);

create table public.sentinel_source_configs (
  id uuid not null default gen_random_uuid(), organization_id uuid not null, incident_id uuid not null, mode text not null,
  schema_version integer not null default 1 check(schema_version = 1),
  configuration jsonb not null check(jsonb_typeof(configuration) = 'object' and octet_length(configuration::text) <= 131072),
  config_hash text not null check(config_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid not null, created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode) references public.sentinel_incident_state(organization_id,incident_id,mode)
);

alter table public.sentinel_incident_state add constraint sentinel_current_config_scope
  foreign key(organization_id,incident_id,mode,current_source_config_revision)
  references public.sentinel_source_configs(organization_id,incident_id,mode,id);

create table public.sentinel_documents (
  id uuid not null default gen_random_uuid(), organization_id uuid not null, incident_id uuid not null, mode text not null,
  document_key text not null check(length(document_key) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,incident_id,mode,id),
  unique(organization_id,incident_id,mode,document_key),
  foreign key(organization_id,incident_id,mode) references public.sentinel_incident_state(organization_id,incident_id,mode)
);

create table public.sentinel_document_versions (
  id uuid not null default gen_random_uuid(), organization_id uuid not null, incident_id uuid not null, mode text not null,
  document_id uuid not null, source_config_revision uuid not null,
  schema_version integer not null default 1 check(schema_version = 1),
  normalization_version text not null check(normalization_version = 'sentinel-text-v1'),
  identity_hash text not null check(identity_hash ~ '^[a-f0-9]{64}$'),
  raw_hash text not null check(raw_hash ~ '^[a-f0-9]{64}$'), normalized_hash text not null check(normalized_hash ~ '^[a-f0-9]{64}$'),
  normalized_bytes integer not null check(normalized_bytes between 0 and 102400),
  normalized_text text,
  issuer text not null check(length(issuer) between 1 and 200), jurisdiction text not null check(length(jurisdiction) between 1 and 200),
  canonical_url text not null check(length(canonical_url) between 1 and 2048),
  published_at timestamptz, effective_from timestamptz, effective_until timestamptz,
  retrieved_at timestamptz not null default clock_timestamp(),
  availability text not null check(availability in ('available','withdrawn','incomplete')),
  content_permission text not null check(content_permission in ('full_text','excerpt_only','metadata_only')),
  primary key(organization_id,incident_id,mode,id),
  unique(organization_id,incident_id,mode,document_id,identity_hash),
  unique(organization_id,incident_id,mode,document_id,id,source_config_revision),
  foreign key(organization_id,incident_id,mode,document_id) references public.sentinel_documents(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,source_config_revision) references public.sentinel_source_configs(organization_id,incident_id,mode,id),
  check(effective_from is null or effective_until is null or effective_from < effective_until),
  check((content_permission = 'full_text' and normalized_text is not null and octet_length(normalized_text) = normalized_bytes)
    or (content_permission <> 'full_text' and normalized_text is null)),
  check(availability <> 'available' or normalized_bytes > 0)
);

create table public.sentinel_retrieval_events (
  id uuid not null default gen_random_uuid(), organization_id uuid not null, incident_id uuid not null, mode text not null,
  document_id uuid not null, source_config_revision uuid not null, checked_version_id uuid,
  requested_at timestamptz not null, completed_at timestamptz not null default clock_timestamp(),
  outcome text not null check(outcome in ('version','same_version','incomplete','failed','withdrawn')),
  observed_raw_hash text check(observed_raw_hash ~ '^[a-f0-9]{64}$'),
  observed_bytes integer not null check(observed_bytes between 0 and 1048576),
  provider_request_id text check(length(provider_request_id) <= 200), safe_error_code text check(length(safe_error_code) <= 100),
  primary key(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,document_id) references public.sentinel_documents(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,source_config_revision) references public.sentinel_source_configs(organization_id,incident_id,mode,id),
  foreign key(organization_id,incident_id,mode,document_id,checked_version_id,source_config_revision)
    references public.sentinel_document_versions(organization_id,incident_id,mode,document_id,id,source_config_revision),
  check(completed_at >= requested_at),
  check(outcome not in ('version','same_version','withdrawn') or checked_version_id is not null)
);

create function public.sentinel_reject_evidence_mutation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'Sentinel evidence records are append-only' using errcode = '55000';
end;
$$;
revoke all on function public.sentinel_reject_evidence_mutation() from public,anon,authenticated,service_role;

create trigger sentinel_source_configs_immutable before update or delete on public.sentinel_source_configs
  for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_documents_immutable before update or delete on public.sentinel_documents
  for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_document_versions_immutable before update or delete on public.sentinel_document_versions
  for each row execute function public.sentinel_reject_evidence_mutation();
create trigger sentinel_retrieval_events_immutable before update or delete on public.sentinel_retrieval_events
  for each row execute function public.sentinel_reject_evidence_mutation();

alter table public.sentinel_incident_state enable row level security;
alter table public.sentinel_source_configs enable row level security;
alter table public.sentinel_documents enable row level security;
alter table public.sentinel_document_versions enable row level security;
alter table public.sentinel_retrieval_events enable row level security;
revoke all on table public.sentinel_incident_state,public.sentinel_source_configs,public.sentinel_documents,
  public.sentinel_document_versions,public.sentinel_retrieval_events from public,anon,authenticated,service_role;

-- Only the trusted application service can call this; actor must come from a fresh authenticated session.
create function public.sentinel_read_document_version(p_actor_id uuid,p_organization_id uuid,p_incident_id uuid,p_mode text,p_version_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public as $$
declare v public.sentinel_document_versions%rowtype;
begin
  if not exists(select 1 from public.organization_members m
    where m.user_id = p_actor_id and m.organization_id = p_organization_id
      and m.role in ('incident_commander','analyst','viewer')) then
    raise exception 'Evidence unavailable' using errcode = '42501';
  end if;
  select * into v from public.sentinel_document_versions d
    where d.organization_id = p_organization_id and d.incident_id = p_incident_id and d.mode = p_mode and d.id = p_version_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id',v.id,'scope',jsonb_build_object('organizationId',v.organization_id,'incidentId',v.incident_id,'mode',v.mode),
    'documentId',v.document_id,'sourceConfigRevision',v.source_config_revision,'schemaVersion',v.schema_version,
    'normalizationVersion',v.normalization_version,'identityHash',v.identity_hash,'rawHash',v.raw_hash,
    'normalizedHash',v.normalized_hash,'normalizedBytes',v.normalized_bytes,'normalizedText',v.normalized_text,
    'issuer',v.issuer,'jurisdiction',v.jurisdiction,'canonicalUrl',v.canonical_url,
    'publishedAt',case when v.published_at is null then null else to_char(v.published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'effectiveFrom',case when v.effective_from is null then null else to_char(v.effective_from at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'effectiveUntil',case when v.effective_until is null then null else to_char(v.effective_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'retrievedAt',to_char(v.retrieved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'availability',v.availability,'contentPermission',v.content_permission);
end;
$$;
revoke all on function public.sentinel_read_document_version(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.sentinel_read_document_version(uuid,uuid,uuid,text,uuid) to service_role;

commit;
