set local lock_timeout = '2s';
set local statement_timeout = '60s';

create or replace function public.fireafter_staged_ingestion_security_version()
returns text language sql stable security invoker set search_path = '' as $$
  with expected(signature,result_type,settings,body_hash,service_execute) as (values
    ('public.fireafter_staged_job(uuid,uuid)','public.ingestion_jobs',array['search_path=""']::text[],
      '17bf53fa6bc554a749547bb6c833ca8caf4a294eb2a982d6a2ad65c1dc142786',false),
    ('public.fireafter_begin_staged_ingestion(uuid,uuid,jsonb)','jsonb',array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      'f8b3913888fe99b9d271e5be149b06d8029ebc5a1f458e9c468d59cdde095b8e',true),
    ('public.fireafter_stage_ingestion_rows(uuid,uuid,text,integer,jsonb)','jsonb',array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      'dee1e02567542941b64fb82986f7ca789e578269ae0bcecd656c36deeee41ce8',true),
    ('public.fireafter_commit_staged_ingestion(uuid,uuid)','uuid',array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      '9679cb900d7ebc7d78bb727dd9f6250c278d097403f4c295b9871f15d91a3737',true),
    ('public.fireafter_commit_bundle(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)','void',array['search_path=""','lock_timeout=2s','statement_timeout=30s']::text[],
      'fe543da2cee605072d697b0747b77b413c97e6108fc0adf0917ff0da967261c2',true),
    ('public.fireafter_persist_bundle(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)','void',array['search_path=public']::text[],
      '8da7cbfdbdec493d6df5322aada6c599de0748964649f91dccbb3b7af3295b8b',false)
  ), functions_ok as (
    select count(*)=6 and bool_and((p.prokind='f' and p.prosecdef and not p.proretset and not p.proisstrict
      and not p.proleakproof and p.provolatile='v' and p.proparallel='u' and p.prorettype=to_regtype(e.result_type)
      and p.pronargdefaults=0 and p.prosupport=0 and p.provariadic=0 and p.proallargtypes is null and p.proargmodes is null
      and p.prolang=(select oid from pg_language where lanname='plpgsql') and p.proconfig=e.settings
      and pg_get_userbyid(p.proowner)='postgres'
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and has_function_privilege('service_role',p.oid,'EXECUTE')=e.service_execute
      and encode(sha256(convert_to(btrim(replace(p.prosrc,E'\r\n',E'\n'),E' \t\r\n'),'UTF8')),'hex')=e.body_hash) is true) as ok
    from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
  ), tables_ok as (
    select count(*)=3 and bool_and((c.relrowsecurity and pg_get_userbyid(c.relowner)='postgres'
      and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) is true) as ok
    from (values ('public.ingestion_staged_bundles'),('public.ingestion_staged_rows'),('public.ingestion_staged_pages')) t(name)
    left join pg_class c on c.oid=to_regclass(t.name)
  ), columns_ok as (
    select exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid='public.ingestion_staged_pages'::regclass and a.attname='common_fields'
      and a.atttypid='jsonb'::regtype and a.attnotnull and not a.attisdropped
      and pg_get_expr(d.adbin,d.adrelid)='''{}''::jsonb')
    and exists(select 1 from pg_attribute a where a.attrelid='public.ingestion_staged_rows'::regclass
      and a.attname='page_position' and a.atttypid='integer'::regtype and not a.attnotnull and not a.attisdropped)
    and exists(select 1 from pg_constraint c where c.conrelid='public.ingestion_staged_pages'::regclass
      and c.conname='ingestion_staged_common_fields_check' and c.contype='c'
      and encode(sha256(convert_to(regexp_replace(pg_get_constraintdef(c.oid),' NOT VALID$',''),'UTF8')),'hex')=
        'c8178eeb4a8b9922cce16cc636980286ac95d0601ef0612e06d5a24b55ce0c3f')
    and exists(select 1 from pg_constraint c where c.conrelid='public.ingestion_staged_rows'::regclass
      and c.conname='ingestion_staged_row_page_fk' and c.contype='f'
      and c.confrelid='public.ingestion_staged_pages'::regclass and c.confdeltype='a'
      and not c.condeferrable
      and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='job_id'),
        (select attnum from pg_attribute where attrelid=c.conrelid and attname='kind'),
        (select attnum from pg_attribute where attrelid=c.conrelid and attname='page_position')]::smallint[]
      and c.confkey=array[(select attnum from pg_attribute where attrelid=c.confrelid and attname='job_id'),
        (select attnum from pg_attribute where attrelid=c.confrelid and attname='kind'),
        (select attnum from pg_attribute where attrelid=c.confrelid and attname='position')]::smallint[]) as ok
  ), index_ok as (
    select exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
      where c.oid=to_regclass('public.ingestion_staged_rows_page_idx')
      and i.indrelid='public.ingestion_staged_rows'::regclass
      and i.indisvalid and i.indisready and i.indislive and not i.indisunique and not i.indisexclusion
      and i.indpred is null and i.indexprs is null and i.indnkeyatts=3 and i.indnatts=3
      and pg_get_userbyid(c.relowner)='postgres'
      and pg_get_indexdef(c.oid)='CREATE INDEX ingestion_staged_rows_page_idx ON public.ingestion_staged_rows USING btree (job_id, kind, page_position)') as ok
  ) select case when f.ok and t.ok and c.ok and i.ok then '20261008140100' else null end
    from functions_ok f,tables_ok t,columns_ok c,index_ok i;
$$;

revoke all on function public.fireafter_staged_ingestion_security_version() from public,anon,authenticated,service_role;
grant execute on function public.fireafter_staged_ingestion_security_version() to service_role;
notify pgrst,'reload schema';
