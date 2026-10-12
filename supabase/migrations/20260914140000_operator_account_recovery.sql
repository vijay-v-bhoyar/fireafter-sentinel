set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Auth is external to this transaction. Pending attempts never expire or retry it.
create table public.operator_account_issuance_attempts (
  attempt_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  email_hash text not null check (email_hash ~ '^[a-f0-9]{64}$'),
  requested_role text not null check (requested_role in ('reviewer','responder','viewer')),
  database_role text not null check (database_role in ('analyst','incident_commander','viewer')),
  operator_identity text not null check (length(operator_identity) between 1 and 320),
  state text not null default 'auth_pending' check (state in ('auth_pending','membership_committed','succeeded')),
  existing_user_id uuid,
  user_id uuid,
  membership_generation bigint not null default 0,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check ((state = 'succeeded') = (completed_at is not null)),
  check (state = 'auth_pending' or user_id is not null)
);
create unique index operator_account_issuance_one_pending_email
  on public.operator_account_issuance_attempts(email_hash) where state <> 'succeeded';
alter table public.operator_account_issuance_attempts owner to postgres;
alter table public.operator_account_issuance_attempts enable row level security;
revoke all on table public.operator_account_issuance_attempts from public, anon, authenticated, service_role;

-- Tombstones survive DELETE, including grant/revoke while no membership remains.
-- Existing memberships start at generation zero without a data backfill.
create table public.operator_account_membership_versions (
  organization_id uuid not null,
  user_id uuid not null,
  generation bigint not null check (generation > 0),
  primary key(organization_id,user_id)
);
alter table public.operator_account_membership_versions owner to postgres;
alter table public.operator_account_membership_versions enable row level security;
revoke all on table public.operator_account_membership_versions from public, anon, authenticated, service_role;
create function public.fireafter_track_account_membership()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if TG_OP = 'TRUNCATE' then
    raise exception 'Membership truncation would bypass issuance generations' using errcode = 'FI409';
  end if;
  if TG_OP <> 'INSERT' then
    insert into public.operator_account_membership_versions(organization_id,user_id,generation)
      values(old.organization_id,old.user_id,1)
      on conflict(organization_id,user_id) do update set generation = operator_account_membership_versions.generation + 1;
  end if;
  if TG_OP = 'INSERT' or (TG_OP = 'UPDATE' and (old.organization_id,old.user_id) is distinct from (new.organization_id,new.user_id)) then
    insert into public.operator_account_membership_versions(organization_id,user_id,generation)
      values(new.organization_id,new.user_id,1)
      on conflict(organization_id,user_id) do update set generation = operator_account_membership_versions.generation + 1;
  end if;
  return null;
end;
$$;
alter function public.fireafter_track_account_membership() owner to postgres;
revoke all on function public.fireafter_track_account_membership() from public, anon, authenticated, service_role;
create trigger fireafter_account_membership_generation
  after insert or update or delete on public.organization_members
  for each row execute function public.fireafter_track_account_membership();
create trigger fireafter_account_membership_no_truncate
  before truncate on public.organization_members
  for each statement execute function public.fireafter_track_account_membership();
alter table public.organization_members enable always trigger fireafter_account_membership_generation;
alter table public.organization_members enable always trigger fireafter_account_membership_no_truncate;

create function public.fireafter_get_account_issuance(p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'version','20260914140000','attemptId',attempt_id,'organizationId',organization_id,
    'emailHash',email_hash,'requestedRole',requested_role,'databaseRole',database_role,
    'operatorIdentity',operator_identity,'state',state,'userId',user_id,
    'created',existing_user_id is null,'claimed',false,'startedAt',started_at,'completedAt',completed_at
  ) from public.operator_account_issuance_attempts where attempt_id = p_attempt_id;
$$;

create function public.fireafter_begin_account_issuance(
  p_attempt_id uuid, p_email text, p_organization_id uuid, p_organization_name text,
  p_requested_role text, p_operator_identity text, p_existing_user_id uuid
)
returns jsonb language plpgsql volatile security definer
set search_path = '' set lock_timeout = '2s' set statement_timeout = '20s'
as $$
declare
  a public.operator_account_issuance_attempts%rowtype;
  h text;
  r text;
  actual_user_id uuid;
  member_generation bigint;
begin
  if p_attempt_id is null or p_organization_id is null or p_email is null
    or p_email <> lower(trim(p_email)) or length(p_email) not between 3 and 320
    or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_organization_name is null or length(trim(p_organization_name)) not between 1 and 320
    or p_operator_identity is null or length(trim(p_operator_identity)) not between 1 and 320 then
    raise exception 'Invalid issuance intent' using errcode = 'FI400';
  end if;
  r := case p_requested_role when 'reviewer' then 'analyst' when 'responder' then 'incident_commander' when 'viewer' then 'viewer' end;
  if r is null then raise exception 'Invalid issuance role' using errcode = 'FI400'; end if;
  h := encode(sha256(convert_to(p_email, 'UTF8')), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(h, 0));
  select * into a from public.operator_account_issuance_attempts where attempt_id = p_attempt_id for update;
  if found then
    if a.email_hash is distinct from h or a.organization_id is distinct from p_organization_id
      or a.requested_role is distinct from p_requested_role or a.operator_identity is distinct from p_operator_identity then
      raise exception 'Issuance reference conflict' using errcode = 'FI409';
    end if;
    return public.fireafter_get_account_issuance(p_attempt_id);
  end if;
  if exists(select 1 from public.operator_account_issuance_attempts where email_hash = h and state <> 'succeeded')
    or exists(select 1 from public.operator_account_issuance_events e
      where e.account_email_hash = h and e.event_type = 'started'
        and not exists(select 1 from public.operator_account_issuance_events s where s.attempt_id = e.attempt_id and s.event_type = 'succeeded')) then
    raise exception 'Unresolved issuance requires reconciliation' using errcode = 'FI409';
  end if;
  select id into actual_user_id from auth.users where lower(email) = p_email;
  if actual_user_id is distinct from p_existing_user_id then
    raise exception 'Auth directory changed before dispatch' using errcode = 'FI409';
  end if;
  perform 1 from public.organization_members where organization_id = p_organization_id and user_id = actual_user_id for share;
  select generation into member_generation from public.operator_account_membership_versions
    where organization_id = p_organization_id and user_id = actual_user_id for share;
  -- No rename of an existing organization; intent and first audit commit together.
  insert into public.organizations(id,name) values(p_organization_id,trim(p_organization_name)) on conflict(id) do nothing;
  insert into public.operator_account_issuance_attempts
    (attempt_id,organization_id,email_hash,requested_role,database_role,operator_identity,existing_user_id,membership_generation)
    values(p_attempt_id,p_organization_id,h,p_requested_role,r,p_operator_identity,actual_user_id,coalesce(member_generation,0));
  insert into public.operator_account_issuance_events
    (attempt_id,organization_id,account_email_hash,requested_role,database_role,operator_identity,event_type)
    values(p_attempt_id,p_organization_id,h,p_requested_role,r,p_operator_identity,'started');
  return public.fireafter_get_account_issuance(p_attempt_id) || '{"claimed":true}'::jsonb;
end;
$$;

create function public.fireafter_advance_account_issuance(p_attempt_id uuid, p_user_id uuid, p_phase text)
returns jsonb language plpgsql volatile security definer
set search_path = '' set lock_timeout = '2s' set statement_timeout = '20s'
as $$
declare
  a public.operator_account_issuance_attempts%rowtype;
  u record;
  member_generation bigint;
  member_exists boolean;
  member_role text;
begin
  if p_attempt_id is null or p_user_id is null or (p_phase = any(array['membership','succeeded'])) is distinct from true then
    raise exception 'Invalid issuance transition' using errcode = 'FI400';
  end if;
  select * into a from public.operator_account_issuance_attempts where attempt_id = p_attempt_id for update;
  if not found then raise exception 'Issuance intent missing' using errcode = 'FI404'; end if;
  if a.state = 'succeeded' then
    if a.user_id is distinct from p_user_id then raise exception 'Issuance identity conflict' using errcode = 'FI409'; end if;
    return public.fireafter_get_account_issuance(p_attempt_id);
  end if;
  select id,email,raw_app_meta_data,banned_until into u from auth.users where id = p_user_id for share;
  if not found or (a.existing_user_id is not null and a.existing_user_id <> p_user_id)
    or encode(sha256(convert_to(lower(u.email), 'UTF8')), 'hex') is distinct from a.email_hash
    or u.raw_app_meta_data->>'fireafter_issuance_attempt_id' is distinct from p_attempt_id::text
    or u.raw_app_meta_data->>'fireafter_issuance_email_hash' is distinct from a.email_hash
    or u.raw_app_meta_data->>'fireafter_role' is distinct from a.database_role
    or u.banned_until > clock_timestamp() then
    raise exception 'Auth outcome is unconfirmed or superseded; do not repeat mutation' using errcode = 'FI409';
  end if;
  select role into member_role from public.organization_members
    where organization_id = a.organization_id and user_id = p_user_id for update;
  member_exists := found;
  select generation into member_generation from public.operator_account_membership_versions
    where organization_id = a.organization_id and user_id = p_user_id for update;
  member_generation := coalesce(member_generation,0);
  if member_generation is distinct from a.membership_generation then
    raise exception 'Membership changed; operator review required' using errcode = 'FI409';
  end if;
  if a.state = 'auth_pending' then
    if p_phase <> 'membership' then raise exception 'Membership not confirmed' using errcode = 'FI409'; end if;
    if not member_exists then
      -- Concurrent insert is a conflict, not an upsert that overwrites new authority.
      insert into public.organization_members(organization_id,user_id,role) values(a.organization_id,p_user_id,a.database_role);
    else
      update public.organization_members set role = a.database_role where organization_id = a.organization_id and user_id = p_user_id;
    end if;
    select generation into member_generation from public.operator_account_membership_versions
      where organization_id = a.organization_id and user_id = p_user_id;
    if member_generation is distinct from a.membership_generation + 1 then
      raise exception 'Membership generation changed during commit' using errcode = 'FI409';
    end if;
    update public.operator_account_issuance_attempts set state = 'membership_committed',user_id = p_user_id,membership_generation = member_generation where attempt_id = p_attempt_id;
  elsif member_role is distinct from a.database_role or a.user_id is distinct from p_user_id then
    raise exception 'Membership no longer matches intent' using errcode = 'FI409';
  elsif p_phase = 'succeeded' then
    insert into public.operator_account_issuance_events
      (attempt_id,organization_id,user_id,account_email_hash,requested_role,database_role,operator_identity,event_type)
      values(a.attempt_id,a.organization_id,p_user_id,a.email_hash,a.requested_role,a.database_role,a.operator_identity,'succeeded');
    update public.operator_account_issuance_attempts set state = 'succeeded',completed_at = clock_timestamp() where attempt_id = p_attempt_id;
  end if;
  return public.fireafter_get_account_issuance(p_attempt_id);
end;
$$;

alter function public.fireafter_get_account_issuance(uuid) owner to postgres;
alter function public.fireafter_begin_account_issuance(uuid,text,uuid,text,text,text,uuid) owner to postgres;
alter function public.fireafter_advance_account_issuance(uuid,uuid,text) owner to postgres;
revoke all on function public.fireafter_get_account_issuance(uuid),
  public.fireafter_begin_account_issuance(uuid,text,uuid,text,text,text,uuid),
  public.fireafter_advance_account_issuance(uuid,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.fireafter_get_account_issuance(uuid),
  public.fireafter_begin_account_issuance(uuid,text,uuid,text,text,text,uuid),
  public.fireafter_advance_account_issuance(uuid,uuid,text) to service_role;
