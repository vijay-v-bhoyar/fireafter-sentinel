create table if not exists public.source_runs (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  adapter_keys text[] not null default '{}',
  warnings text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.incidents
  add column if not exists location_context jsonb,
  add column if not exists fire_candidates jsonb not null default '[]'::jsonb,
  add column if not exists coverage_status text not null default 'not_available';

alter table public.source_snapshots
  add column if not exists source_run_id uuid references public.source_runs(id) on delete set null,
  add column if not exists source_key text,
  add column if not exists source_url text,
  add column if not exists coverage_status text not null default 'not_available',
  add column if not exists warnings text[] not null default '{}',
  add column if not exists derived_signals jsonb not null default '{}'::jsonb;

alter table public.assets
  add column if not exists geometry_geojson jsonb,
  add column if not exists origin text,
  add column if not exists source_key text,
  add column if not exists source_url text,
  add column if not exists source_feature_id text,
  add column if not exists source_feature_ids text[] not null default '{}',
  add column if not exists coverage_status text not null default 'not_available',
  add column if not exists confidence_reason text;

alter table public.recommendations
  add column if not exists evidence jsonb not null default '[]'::jsonb,
  add column if not exists metric_status jsonb not null default '{}'::jsonb,
  add column if not exists source_snapshot_ids text[] not null default '{}';

create index if not exists source_runs_incident_started_idx
  on public.source_runs (incident_id, started_at desc);

create index if not exists source_snapshots_source_key_idx
  on public.source_snapshots (incident_id, source_key, fetched_at desc);

create index if not exists assets_source_feature_ids_idx
  on public.assets using gin (source_feature_ids);

alter table public.source_runs enable row level security;

grant select on public.source_runs to authenticated;
grant select, insert, update, delete on public.source_runs to service_role;
grant select, insert, update, delete on public.organizations to service_role;
grant select, insert, update, delete on public.organization_members to service_role;
grant select, insert, update, delete on public.incidents to service_role;
grant select, insert, update, delete on public.source_snapshots to service_role;
grant select, insert, update, delete on public.assets to service_role;
grant select, insert, update, delete on public.recommendations to service_role;
grant select, insert on public.responder_actions to service_role;
grant select, insert on public.audit_events to service_role;

create policy "members can read source runs"
on public.source_runs for select
to authenticated
using (
  exists (
    select 1
    from public.incidents i
    join public.organization_members om on om.organization_id = i.organization_id
    where i.id = source_runs.incident_id
      and om.user_id = (select auth.uid())
  )
);

create or replace function public.fireafter_prevent_append_only_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'FireAfter audit/action records are append-only';
end;
$$;

drop trigger if exists responder_actions_append_only on public.responder_actions;
create trigger responder_actions_append_only
before update or delete on public.responder_actions
for each row execute function public.fireafter_prevent_append_only_mutation();

drop trigger if exists audit_events_append_only on public.audit_events;
create trigger audit_events_append_only
before update or delete on public.audit_events
for each row execute function public.fireafter_prevent_append_only_mutation();
