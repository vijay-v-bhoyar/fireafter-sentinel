-- Source observation timestamps use the same checked clock as publication.
-- No client clock tolerance, new mutation authority or lease extension is added.
create function public.sentinel_read_worker_clock(p_org uuid,p_incident uuid,p_mode text,p_run uuid,p_owner uuid,p_fence bigint)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.sentinel_runs%rowtype;stamp timestamptz;
begin
 r:=public.sentinel_lock_worker_run(p_org,p_incident,p_mode,p_run);
 stamp:=date_trunc('milliseconds',clock_timestamp());
 perform public.sentinel_assert_lease(r,p_owner,p_fence,stamp);
 return to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
end;$$;
revoke all on function public.sentinel_read_worker_clock(uuid,uuid,text,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.sentinel_read_worker_clock(uuid,uuid,text,uuid,uuid,bigint) to service_role;
