create extension if not exists postgis with schema extensions;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('incident_commander', 'analyst', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  county text not null,
  state text not null,
  title text not null,
  status text not null,
  storm_window text not null,
  selected_fire jsonb not null default '{}'::jsonb,
  last_refresh timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.source_snapshots (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  source_name text not null,
  fetched_at timestamptz not null,
  source_updated_at timestamptz,
  status text not null check (status in ('online', 'delayed', 'offline')),
  stale boolean not null default false,
  freshness_label text not null,
  raw_payload jsonb not null default '{}'::jsonb
);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  name text not null,
  asset_type text not null,
  location_label text not null,
  geom extensions.geography(point, 4326),
  source text not null,
  confidence text not null check (confidence in ('High', 'Medium', 'Low')),
  local_or_uploaded boolean not null default false,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists assets_geom_idx on public.assets using gist (geom);

create table if not exists public.recommendations (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  final_score numeric not null,
  score_100 integer not null,
  risk_level text not null,
  confidence_level text not null,
  recommended_action text not null,
  reason_codes text[] not null default '{}',
  limitations text[] not null default '{}',
  changed_since_last_refresh text not null,
  score_breakdown jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.responder_actions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.recommendations(id) on delete cascade,
  action text not null check (action in ('accept', 'modify', 'reject', 'annotate')),
  note text not null default '',
  actor_id uuid references auth.users(id),
  actor_name text not null,
  modified_priority text,
  recommendation_snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  recommendation_id uuid references public.recommendations(id) on delete set null,
  event_type text not null,
  actor_id uuid references auth.users(id),
  actor_name text not null,
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.incidents enable row level security;
alter table public.source_snapshots enable row level security;
alter table public.assets enable row level security;
alter table public.recommendations enable row level security;
alter table public.responder_actions enable row level security;
alter table public.audit_events enable row level security;

grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.organization_members to authenticated;
grant select, insert, update, delete on public.incidents to authenticated;
grant select, insert, update, delete on public.source_snapshots to authenticated;
grant select, insert, update, delete on public.assets to authenticated;
grant select, insert, update, delete on public.recommendations to authenticated;
grant select, insert on public.responder_actions to authenticated;
grant select, insert on public.audit_events to authenticated;

create policy "members can read their organizations"
on public.organizations for select
to authenticated
using (
  exists (
    select 1 from public.organization_members om
    where om.organization_id = organizations.id
      and om.user_id = (select auth.uid())
  )
);

create policy "members can read org membership"
on public.organization_members for select
to authenticated
using (user_id = (select auth.uid()));

create policy "members can read incidents"
on public.incidents for select
to authenticated
using (
  exists (
    select 1 from public.organization_members om
    where om.organization_id = incidents.organization_id
      and om.user_id = (select auth.uid())
  )
);

create policy "members can manage incidents"
on public.incidents for all
to authenticated
using (
  exists (
    select 1 from public.organization_members om
    where om.organization_id = incidents.organization_id
      and om.user_id = (select auth.uid())
      and om.role in ('incident_commander', 'analyst')
  )
)
with check (
  exists (
    select 1 from public.organization_members om
    where om.organization_id = incidents.organization_id
      and om.user_id = (select auth.uid())
      and om.role in ('incident_commander', 'analyst')
  )
);

create policy "members can read incident children"
on public.source_snapshots for select
to authenticated
using (exists (select 1 from public.incidents i join public.organization_members om on om.organization_id = i.organization_id where i.id = source_snapshots.incident_id and om.user_id = (select auth.uid())));

create policy "members can read assets"
on public.assets for select
to authenticated
using (exists (select 1 from public.incidents i join public.organization_members om on om.organization_id = i.organization_id where i.id = assets.incident_id and om.user_id = (select auth.uid())));

create policy "members can read recommendations"
on public.recommendations for select
to authenticated
using (exists (select 1 from public.incidents i join public.organization_members om on om.organization_id = i.organization_id where i.id = recommendations.incident_id and om.user_id = (select auth.uid())));

create policy "members can create actions"
on public.responder_actions for insert
to authenticated
with check (
  exists (
    select 1
    from public.recommendations r
    join public.incidents i on i.id = r.incident_id
    join public.organization_members om on om.organization_id = i.organization_id
    where r.id = responder_actions.recommendation_id
      and om.user_id = (select auth.uid())
      and om.role in ('incident_commander', 'analyst')
  )
);

create policy "members can read actions"
on public.responder_actions for select
to authenticated
using (
  exists (
    select 1
    from public.recommendations r
    join public.incidents i on i.id = r.incident_id
    join public.organization_members om on om.organization_id = i.organization_id
    where r.id = responder_actions.recommendation_id
      and om.user_id = (select auth.uid())
  )
);

create policy "members can read audit"
on public.audit_events for select
to authenticated
using (exists (select 1 from public.incidents i join public.organization_members om on om.organization_id = i.organization_id where i.id = audit_events.incident_id and om.user_id = (select auth.uid())));
