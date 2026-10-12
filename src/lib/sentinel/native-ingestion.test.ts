import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createIncidentFromLocation,searchLocations} from '../fireafter-store';
import {runLiveSourceRefresh,fetchNwsSource,type AdapterMap,type LiveSourceResult} from '../live-sources';
import {buildSupabasePayload,mapSupabaseRowsToBundle} from '../fireafter-supabase';
import {prepareIngestionPayload} from '../ingestion-payload';
import {encodeCheckpoint,decodeCheckpoint} from '../ingestion-checkpoint';
import {stageIngestionPayload,STAGED_COMMIT_SECURITY_VERSION} from '../ingestion-staged';
import type {IngestionJob} from '../ingestion-store';
import {sentinelEvidenceSqlFixture} from '@/test/sentinel-evidence-sql-fixture';
import {prepareDocumentVersion} from './evidence';
import {sealNativeAcquisition,verifiedNativeAcquisition} from './native-provenance';

const staging=vi.hoisted(()=>({checkpoints:new Map<string,unknown>(),rows:[] as Record<string,unknown>[],counts:{source:0,asset:0,recommendation:0}}));
vi.mock('../ingestion-store',()=>({
 readCheckpoint:async(_id:string,key:string)=>staging.checkpoints.get(key)??null,
 putCheckpoint:async(_job:unknown,key:string,value:unknown)=>{staging.checkpoints.set(key,structuredClone(value));},
 ingestionRpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='fireafter_staged_ingestion_security_version')return STAGED_COMMIT_SECURITY_VERSION;
  if(name==='fireafter_stage_ingestion_rows'){
   const page=args.p_rows as Record<string,unknown>[]|{shared:Record<string,unknown>;rows:Record<string,unknown>[]};
   const rows=Array.isArray(page)?page:page.rows.map(row=>({...page.shared,...row}));
   const kind=args.p_kind as keyof typeof staging.counts;staging.counts[kind]+=rows.length;
   if(kind==='source')staging.rows.push(...structuredClone(rows));
  }
  return {...staging.counts};
 }
}));
const id=(n:number)=>`73000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),incidentId:id(2),mode:'live' as const},keyId=id(7),secret='ac'.repeat(32);
const now=new Date('2026-10-12T07:00:00Z');
const incident=createIncidentFromLocation(searchLocations('ventura-ca')[0]);
const write={actorId:id(9),organizationId:scope.organizationId,databaseIncidentId:scope.incidentId,expectedRevision:id(10),operation:'refresh' as const};
const requests:string[]=[];
const fetchImpl=vi.fn(async(url:RequestInfo|URL)=>{
 const text=String(url);requests.push(text);
 if(text.includes('/points/'))return Response.json({properties:{forecastGridData:'https://api.weather.gov/gridpoints/LOX/1,1',cwa:'LOX'}});
 if(text.includes('/gridpoints/'))return Response.json({properties:{updateTime:'2026-10-12T06:50:00Z',quantitativePrecipitation:{uom:'wmoUnit:mm',values:[{validTime:'2026-10-12T07:00:00Z/PT48H',value:20}]}}});
 if(text.includes('/alerts/'))return Response.json({features:[]});
 throw new Error('Unexpected provider call in native fixture');
}) as unknown as typeof fetch;
const custom=(key:string):LiveSourceResult=>({sourceKey:key,sourceName:'Synthetic custom source',sourceUrl:'https://example.gov/fixture',status:'online',stale:false,fetchedAt:now.toISOString(),sourceUpdatedAt:'',sourceTimeBasis:'unknown',coverageStatus:'available',freshnessLabel:'Fixture',detail:'Synthetic',warnings:[],rawPayload:{},derivedSignals:{}});
async function refresh(nws?:LiveSourceResult){
 const adapters:Partial<AdapterMap>=Object.fromEntries(['wfigs','firms','pwfdf','roads','hydro'].map(key=>[key,async()=>custom(key)]));
 if(nws)adapters.nws=async()=>nws;
 return runLiveSourceRefresh({incident,assets:[],now,fetchImpl,adapters,skipElevation:true,derivedAssets:{assets:[],batchElevationUnavailable:false}});
}
let fixture:Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
beforeAll(async()=>{
 fixture=await sentinelEvidenceSqlFixture();
 // Only these inherited non-spatial columns are added for exact row serialization.
 // This remains an embedded fixture, not the full inherited migration chain.
 await fixture.db.exec(`alter table public.source_snapshots add column source_key text,add column source_url text,add column coverage_status text not null default 'not_available',add column warnings text[] not null default '{}',add column derived_signals jsonb not null default '{}'::jsonb`);
},20000);
beforeEach(async()=>{
 vi.stubEnv('SENTINEL_NATIVE_SIGNING_KEY_ID',keyId);vi.stubEnv('SENTINEL_NATIVE_SIGNING_ORGANIZATION_ID',scope.organizationId);vi.stubEnv('SENTINEL_NATIVE_SIGNING_KEY_HEX',secret);
 vi.stubEnv('FIREAFTER_NWS_USER_AGENT','Sentinel synthetic tests (test@example.com)');
 requests.length=0;staging.checkpoints.clear();staging.rows=[];staging.counts={source:0,asset:0,recommendation:0};
 await fixture.db.exec('begin');
 const v=prepareDocumentVersion({scope,documentId:id(3),sourceConfigRevision:id(4),issuer:'Synthetic fixture',jurisdiction:'Fixture',canonicalUrl:'https://example.gov/fixture',rawText:'Synthetic',publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:'available',contentPermission:'full_text'},{id:id(5),retrievedAt:now.toISOString()}).version;
 await fixture.seed(v,id(9),'incident_commander');
 await fixture.db.query(`insert into public.sentinel_native_signing_keys(organization_id,id,secret_key,authority_evidence_hash,valid_from,valid_until) values($1,$2,$3,$4,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,[scope.organizationId,keyId,Buffer.from(secret,'hex'),'c'.repeat(64)]);
});
afterEach(async()=>{await fixture.db.exec('rollback');vi.unstubAllEnvs();});afterAll(async()=>{await fixture?.close();});
async function storedValid(row:Record<string,unknown>){
 await fixture.db.query('insert into public.source_snapshots select * from jsonb_populate_record(null::public.source_snapshots,$1::jsonb)',[JSON.stringify(row)]);
 return (await fixture.db.query<{valid:boolean}>('select public.sentinel_native_binding_valid(n,$2,$3,$4,clock_timestamp()) as valid from public.source_snapshots n where n.id=$1',[row.id,scope.organizationId,scope.incidentId,scope.mode])).rows[0].valid;
}
describe('native acquisition through direct and staged persistence; synthetic HTTP/DB only',()=>{
 it('signs the actual default NWS adapter in a mixed run and verifies the exact persisted row after hydration',async()=>{
  const bundle=await refresh(),source=bundle.sourceSnapshots.find(s=>s.sourceKey==='nws')!;
  expect(requests).toHaveLength(3);expect(source.status).toBe('online');expect(verifiedNativeAcquisition(source,incident.id,scope.organizationId)).not.toBeNull();
  expect(bundle.sourceSnapshots.filter(s=>s.sourceKey!=='nws').every(s=>!s.nativeAcquisition)).toBe(true);
  const payload=buildSupabasePayload(bundle,{write,assets:[]}),row=payload.sourceSnapshots.find(s=>s.source_key==='nws')!;
  expect(await storedValid(row)).toBe(true);
  const recovered=mapSupabaseRowsToBundle(payload).sourceSnapshots.find(s=>s.sourceKey==='nws')!;
  expect(verifiedNativeAcquisition(recovered,incident.id,scope.organizationId)).not.toBeNull();expect(recovered.fetchedAt).toBe(source.fetchedAt);
  expect(JSON.stringify(payload)).not.toContain(secret);
 });
 it('never signs an unsigned custom adapter result merely because configuration is present',async()=>{
  const bundle=await refresh(await fetchNwsSource(incident.locationContext!,{now,fetchImpl}));
  expect(bundle.sourceSnapshots.find(s=>s.sourceKey==='nws')!.nativeAcquisition).toBeUndefined();
  const row=buildSupabasePayload(bundle,{write,assets:[]}).sourceSnapshots.find(s=>s.source_key==='nws')!;
  expect(row.raw_payload.sentinelNativeBinding).toBeUndefined();expect(await storedValid(row)).toBe(false);
 });
 it('retains the original acquisition through a compressed worker checkpoint and staged row transport',async()=>{
  const original=sealNativeAcquisition(await fetchNwsSource(incident.locationContext!,{now,fetchImpl}),incident.id,'live');
  const encoded=encodeCheckpoint(original),checkpoint=decodeCheckpoint<LiveSourceResult>(encoded.manifest,encoded.parts.map((value,part)=>({part,value})));
  const bundle=await refresh(checkpoint),payload=prepareIngestionPayload(id(11),'final',bundle,write,now);
  expect(await stageIngestionPayload({id:id(11),lease_id:id(12)} as IngestionJob,payload)).toBe(true);
  const row=staging.rows.find(s=>s.source_key==='nws')!;
  expect(row).toEqual(payload.sourceSnapshots.find(s=>s.source_key==='nws'));expect(await storedValid(row)).toBe(true);expect(row.fetched_at).toBe(original.fetchedAt);
 });
 it('holds altered checkpoint content and cross-organization publication without silently renewing authority',async()=>{
  const original=sealNativeAcquisition(await fetchNwsSource(incident.locationContext!,{now,fetchImpl}),incident.id,'live');
  const altered=await refresh({...original,rawPayload:{forged:true}});
  const row=buildSupabasePayload(altered,{write,assets:[]}).sourceSnapshots.find(s=>s.source_key==='nws')!;
  expect(await storedValid(row)).toBe(false);
  const valid=await refresh(original),cross=buildSupabasePayload(valid,{write:{...write,organizationId:id(99)},assets:[]}).sourceSnapshots.find(s=>s.source_key==='nws')!;
  expect(cross.raw_payload.sentinelNativeBinding).toBeUndefined();
 });
 it('keeps ordinary source content but issues no authority when the signing key is unconfigured',async()=>{
  vi.stubEnv('SENTINEL_NATIVE_SIGNING_KEY_HEX','');const bundle=await refresh(),source=bundle.sourceSnapshots.find(s=>s.sourceKey==='nws')!;
  expect(source.rawPayload).toHaveProperty('rainfallStatus','available');expect(source.nativeAcquisition).toBeUndefined();
  expect(buildSupabasePayload(bundle,{write,assets:[]}).sourceSnapshots.find(s=>s.source_key==='nws')!.raw_payload.sentinelNativeBinding).toBeUndefined();
 });
});
