import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {sentinelEvidenceSqlFixture} from '@/test/sentinel-evidence-sql-fixture';
import {prepareDocumentVersion} from './evidence';
import {recordConstraints} from './constraints';
import {admitRun,acquireRunLease,cancelRun} from './runs';
import {publishEvidence} from './publication';
import {recordPolicy} from './policies';
import {runSentinelStep} from './worker';

const boundary=vi.hoisted(()=>({rpc:vi.fn(),user:vi.fn()}));
vi.mock('../supabase',()=>({getSupabaseAdminClient:()=>({rpc:boundary.rpc})}));
vi.mock('../auth',()=>({getCurrentUser:()=>boundary.user()}));
const id=(n:number)=>`77000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),incidentId:id(2),mode:'live' as const},actor=id(9),model='nvidia/Nemotron-fixture',evidence='a'.repeat(64),text='Canyon Road is closed until noon.';
const seeded=prepareDocumentVersion({scope,documentId:id(3),sourceConfigRevision:id(4),issuer:'Synthetic county',jurisdiction:'Fixture',canonicalUrl:'https://example.gov/notice',rawText:'Synthetic seed.',publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:'available',contentPermission:'full_text'},{id:id(5),retrievedAt:'2026-10-12T07:00:00Z'}).version;
let fixture:Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>,calls:{url:string;body:Record<string,unknown>}[],defect:string,rpcFailures:{name:string;code?:string;message?:string}[];
beforeAll(async()=>{fixture=await sentinelEvidenceSqlFixture();},20000);
beforeEach(async()=>{
 await fixture.db.exec('begin');await fixture.seed(seeded,actor,'analyst');defect='';calls=[];rpcFailures=[];
 boundary.user.mockResolvedValue({id:actor,organizationId:scope.organizationId,role:'analyst'});
 boundary.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
  try{
   const parameters=(await fixture.db.query<{proargnames:string[]}>('select proargnames from pg_proc where proname=$1 and pronamespace=\'public\'::regnamespace',[name])).rows[0]?.proargnames;
   if(!parameters||parameters.some(p=>!(p in args)))throw new Error('Fixture RPC named arguments mismatch');
   return {data:await fixture.rpc(name,parameters.map(p=>{const value=args[p];return value!==null&&typeof value==='object'?JSON.stringify(value):value;})),error:null};
  }catch(error){const e=error as {code?:string;message?:string};rpcFailures.push({name,code:e.code,message:e.message});return {data:null,error};}
 });
 for(const [key,value] of Object.entries({SENTINEL_TAVILY_API_KEY:'synthetic',SENTINEL_NEBIUS_API_KEY:'synthetic',SENTINEL_NEBIUS_BASE_URL:'https://api.tokenfactory.nebius.com/v1/',SENTINEL_NEMOTRON_EXTRACTION_MODEL:model,SENTINEL_NEMOTRON_RECONCILIATION_MODEL:model,SENTINEL_TOKENIZER_EVIDENCE_HASH:evidence}))vi.stubEnv(key,value);
 await fixture.db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,'live',$4,$5,$6)`,[id(7),scope.organizationId,scope.incidentId,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),canonicalUrl:'https://example.gov/notice',issuer:'Synthetic county',jurisdiction:'Fixture',contentPermission:'full_text'}]}),'b'.repeat(64),actor]);
 await fixture.db.query('update public.sentinel_incident_state set current_source_config_revision=$1',[id(7)]);
 await fixture.db.query(`insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,'Canyon Road','road','Synthetic','Synthetic','Low')`,[id(50),scope.incidentId]);
 const startsAt=new Date(Math.ceil(Date.now()/60000)*60000+300000).toISOString(),endsAt=new Date(Date.parse(startsAt)+3600000).toISOString();
 await recordConstraints({incidentId:scope.incidentId,mode:'live',commandId:id(60),expectedConstraintRevision:null,configuration:{schemaVersion:1,shift:{startsAt,endsAt},inputBasis:'user_authored',crews:[{id:id(61),label:'Synthetic crew',capabilities:['road'],availableFrom:startsAt,availableUntil:endsAt}],tasks:[{id:id(62),assetId:id(50),label:'Synthetic road review',taskType:'inspection',requiredCapability:'road',durationMinutes:10,travelMinutes:0,windowFrom:startsAt,windowUntil:endsAt,priority:1}]}});
 for(const [n,provider,operation,modelId] of [[20,'tavily','search',null],[21,'tavily','extract',null],[22,'nebius','extract_claims',model],[23,'nebius','compare_claims',model]] as const){
  await fixture.db.query(`insert into public.sentinel_provider_prices(id,organization_id,provider,operation,model_id,request_micro_usd,input_micro_usd_per_million,output_micro_usd_per_million,request_units,authority_evidence_hash,valid_from,valid_until) values($1,$2,$3,$4,$5,1,case when $3='tavily' then 0 else 1 end,case when $3='tavily' then 0 else 1 end,$6,$7,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`,[id(n),scope.organizationId,provider,operation,modelId,provider==='tavily'?2000000:0,evidence]);
 }
 for(const provider of ['tavily','nebius'])await fixture.db.query(`insert into public.sentinel_provider_funds(organization_id,provider,ceiling_micro_usd,ceiling_units,authority_evidence_hash) values($1,$2,1000000,100000000,$3)`,[scope.organizationId,provider,evidence]);
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
  const body=JSON.parse(String(init.body)) as Record<string,unknown>;calls.push({url,body});
  if(url==='https://api.tavily.com/search')return Response.json({request_id:'fixture-search',results:[{url:'https://example.gov/notice',title:'Synthetic notice',content:text},...(defect==='siblings'?[{url:'https://forecast.example.gov/notice',title:'Unregistered sibling',content:'Withhold'}]:[])],usage:{credits:1}});
  if(url==='https://api.tavily.com/extract')return Response.json({request_id:'fixture-extract',results:defect==='partial'?[]:[{url:'https://example.gov/notice',raw_content:defect==='context'?'x'.repeat(10000):text}],failed_results:defect==='partial'?[{url:'https://example.gov/notice',error:'Fixture unavailable'}]:defect==='mixed'?[{url:'https://example.gov/notice-two',error:'Fixture unavailable'}]:[],usage:{credits:1}});
  if(url!=='https://api.tokenfactory.nebius.com/v1/chat/completions')throw new Error('Unexpected outbound endpoint');
  const messages=body.messages as {content:string}[],extract=messages[0].content.startsWith('Extract');
  const output=extract?{claims:[{excerpt:defect==='quote'?'Fabricated quote':text,kind:'road_status',claimText:text,entityMentions:['Canyon Road']}]}:{changes:[{index:0,category:'addition',materiality:'material',claimIndexes:[0],explanation:'Synthetic source addition.'}]};
  return Response.json({id:'fixture-model',model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output),...(defect==='tool'?{tool_calls:[{name:'approve_plan'}]}:{})}}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}});
 }));
});
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await fixture.db.exec('rollback');});afterAll(async()=>{await fixture?.close();});
async function start(commandId=id(8)){return (await admitRun({incidentId:scope.incidentId,mode:'live',sourceConfigRevision:id(7),commandId})).run;}
async function execute(runId:string){for(let i=0;i<20;i++){const result=await runSentinelStep(runId);if(result==='stop'){if((await status(runId)).status==='failed')console.error('Synthetic worker diagnostic',{status:await status(runId),rpcFailures,stages:(await fixture.db.query('select sequence,kind from public.sentinel_worker_outputs where run_id=$1',[runId])).rows});return;}expect(result).toBe('continue');}throw new Error('Worker did not terminate');}
async function status(runId:string){return (await fixture.db.query<{status:string;stage:string;tavily_requests:number;model_requests:number}>('select status,stage,tavily_requests,model_requests from public.sentinel_runs where id=$1',[runId])).rows[0];}
describe('actual worker/helper/provider transport against synthetic HTTP and exact seventeen-migration SQL',()=>{
 it('reports an unsupported model context distinctly while retaining evidence and avoiding an inference charge',async()=>{
  defect='context';const run=await start();await execute(run.id);
  expect(await status(run.id)).toMatchObject({status:'failed',stage:'model_context_unsupported',tavily_requests:2,model_requests:0});
  expect((await fixture.db.query('select * from public.sentinel_claims')).rows).toHaveLength(0);
  const savedEvidence=(await fixture.db.query<{payload:{versions:{versionId:string}[]}}>("select payload from public.sentinel_worker_outputs where run_id=$1 and kind='evidence'",[run.id])).rows[0];
  expect((await fixture.db.query<{normalized_text:string}>('select normalized_text from public.sentinel_document_versions where id=$1',[savedEvidence.payload.versions[0].versionId])).rows[0].normalized_text).toHaveLength(10000);
  expect(calls.filter(c=>c.url.includes('tokenfactory'))).toHaveLength(0);
 });
 it('retains the discovery withholding count without publishing sibling hosts or skipping source extraction',async()=>{
  defect='siblings';const run=await start();await execute(run.id);expect(await status(run.id)).toMatchObject({status:'completed',tavily_requests:2,model_requests:2});
  const saved=(await fixture.db.query<{payload:{withheldResultCount:number;results:{url:string}[]}}>("select payload from public.sentinel_worker_outputs where run_id=$1 and kind='search'",[run.id])).rows[0].payload;
  expect(saved.withheldResultCount).toBe(1);expect(saved.results.map(x=>x.url)).toEqual(['https://example.gov/notice']);expect((await fixture.db.query('select * from public.sentinel_decisions')).rows).toHaveLength(0);
 });
 it('publishes real persisted source/claim/change records and finishes computation without human approval',async()=>{
  const run=await start();await execute(run.id);expect(await status(run.id)).toMatchObject({status:'completed',tavily_requests:2,model_requests:2});
  const claims=(await fixture.db.query<{body:{entityIds:string[]}}>('select body from public.sentinel_claims')).rows;expect(claims).toHaveLength(1);expect(claims[0].body.entityIds).toEqual([id(50)]);
  expect((await fixture.db.query('select * from public.sentinel_changes')).rows).toHaveLength(1);expect((await fixture.db.query('select * from public.sentinel_decisions')).rows).toHaveLength(0);
  const modelBodies=calls.filter(c=>c.url.includes('tokenfactory')).map(c=>JSON.stringify(c.body));expect(modelBodies.every(b=>!b.includes(id(50))&&!b.includes(actor)&&!b.includes('Private reviewer note'))).toBe(true);
  const generation=(await fixture.db.query<{unresolved_source_change_count:number}>('select unresolved_source_change_count from public.sentinel_incident_state')).rows[0];expect(generation.unresolved_source_change_count).toBe(1);
 });
 it('rechecks identical content without new versions, replacement reviews or repeated inference',async()=>{
  const first=await start();await execute(first.id);const head=(await fixture.db.query('select version_id from public.sentinel_document_heads')).rows[0];
  const second=await start(id(80));calls=[];await execute(second.id);expect(await status(second.id)).toMatchObject({status:'completed',tavily_requests:2,model_requests:0});
  expect((await fixture.db.query('select version_id from public.sentinel_document_heads')).rows[0]).toEqual(head);expect(calls).toHaveLength(2);expect((await fixture.db.query('select * from public.sentinel_changes')).rows).toHaveLength(1);
 });
 it('records HTTP200 partial retrieval as incomplete and stops before model interpretation',async()=>{
  defect='partial';const run=await start();await execute(run.id);expect(await status(run.id)).toMatchObject({status:'failed',model_requests:0});expect((await fixture.db.query('select * from public.sentinel_claims')).rows).toHaveLength(0);expect((await fixture.db.query('select * from public.sentinel_retrieval_events')).rows).toHaveLength(1);
 });
 it('preserves individual successful and failed URLs in a partial batch with the actual provider request identity',async()=>{
  const configuration={schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),canonicalUrl:'https://example.gov/notice',issuer:'Synthetic county',jurisdiction:'Fixture',contentPermission:'full_text'},{documentId:id(83),documentKey:id(83),canonicalUrl:'https://example.gov/notice-two',issuer:'Synthetic county',jurisdiction:'Fixture',contentPermission:'full_text'}]};
  await fixture.db.query(`insert into public.sentinel_documents(id,organization_id,incident_id,mode,document_key) values($1,$2,$3,'live',$4)`,[id(83),scope.organizationId,scope.incidentId,id(83)]);
  await fixture.db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,'live',$4,$5,$6)`,[id(84),scope.organizationId,scope.incidentId,JSON.stringify(configuration),'c'.repeat(64),actor]);await fixture.db.query('update public.sentinel_incident_state set current_source_config_revision=$1',[id(84)]);
  defect='mixed';const run=(await admitRun({incidentId:scope.incidentId,mode:'live',sourceConfigRevision:id(84),commandId:id(85)})).run;await execute(run.id);
  expect(await status(run.id)).toMatchObject({status:'failed',model_requests:0});expect((await fixture.db.query('select * from public.sentinel_document_heads')).rows).toHaveLength(1);
  const events=(await fixture.db.query<{outcome:string;provider_request_id:string}>('select outcome,provider_request_id from public.sentinel_retrieval_events order by outcome')).rows;expect(events.map(e=>e.outcome)).toEqual(['failed','version']);expect(events.every(e=>e.provider_request_id==='fixture-extract')).toBe(true);
 });
 it('withholds fabricated citations and keeps the charged original attempt instead of approving a result',async()=>{
  defect='quote';const run=await start();await execute(run.id);expect(await status(run.id)).toMatchObject({status:'failed',model_requests:1});expect((await fixture.db.query('select * from public.sentinel_claims')).rows).toHaveLength(0);expect((await fixture.db.query('select * from public.sentinel_priced_reservations')).rows).toHaveLength(3);
 });
 it('publishes retrieval bounds from the lease-checked database clock instead of the application wall clock',async()=>{
  const original=boundary.rpc.getMockImplementation()!,clocks:string[]=[],publications:Record<string,unknown>[]=[];
  boundary.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
   const result=await original(name,args);if(name==='sentinel_read_worker_clock'&&!result.error)clocks.push(result.data);
   if(name==='sentinel_publish_evidence')publications.push(args);return result;
  });
  const run=await start();await execute(run.id);expect(await status(run.id)).toMatchObject({status:'completed'});
  expect(clocks).toHaveLength(2);const observations=publications[0].p_observations as {requestedAt:string;version:{retrievedAt:string}}[];
  expect(observations[0].requestedAt).toBe(clocks[0]);expect(observations[0].version.retrievedAt).toBe(clocks[1]);
 });
 it('keeps worker clock scope and lease authority private',async()=>{
  const run=await start(),owner=id(190),leased=await acquireRunLease({scope,runId:run.id,owner});
  const args=[scope.organizationId,scope.incidentId,scope.mode,run.id,owner,leased.run.fence];
  const stamp=await fixture.rpc<string>('sentinel_read_worker_clock',args);expect(Number.isFinite(Date.parse(stamp))).toBe(true);
  await expect(fixture.rpc('sentinel_read_worker_clock',[...args.slice(0,5),leased.run.fence+1])).rejects.toMatchObject({code:'40001'});
  const grants=(await fixture.db.query<{allowed:boolean}>("select has_function_privilege('authenticated','public.sentinel_read_worker_clock(uuid,uuid,text,uuid,uuid,bigint)','execute') as allowed")).rows[0];expect(grants.allowed).toBe(false);
 });
 it('resumes saved stages with fresh owner fences and does not fetch or charge again',async()=>{
  const run=await start();for(let i=0;i<3;i++)expect(await runSentinelStep(run.id)).toBe('continue');expect(calls).toHaveLength(2);
  await execute(run.id);expect(calls.filter(c=>c.url.includes('tavily'))).toHaveLength(2);expect(await status(run.id)).toMatchObject({status:'completed'});
 });
 it('stops revoked or canceled work before another provider side effect',async()=>{
  const run=await start();expect(await runSentinelStep(run.id)).toBe('continue');await fixture.rpc('sentinel_cancel_run',[actor,scope.organizationId,scope.incidentId,'live',run.id,id(90)]);expect(await runSentinelStep(run.id)).toBe('stop');expect(calls).toHaveLength(0);
 });
 it('rejects model tool actions and keeps the original paid hold instead of executing them',async()=>{
  defect='tool';const run=await start();await execute(run.id);expect(await status(run.id)).toMatchObject({status:'failed',model_requests:1});expect((await fixture.db.query('select * from public.sentinel_decisions')).rows).toHaveLength(0);expect((await fixture.db.query("select * from public.sentinel_provider_reservations where state='uncertain'")).rows).toHaveLength(1);
 });
 it.each([false,true])('uses only eligible recorded corpus evidence; future relative to scenario=%s',async future=>{
  await fixture.db.exec("update public.organization_members set role='incident_commander'");boundary.user.mockResolvedValue({id:actor,organizationId:scope.organizationId,role:'incident_commander'});
  const replayScope={...scope,mode:'replay' as const},seed=prepareDocumentVersion({scope:replayScope,documentId:id(103),sourceConfigRevision:id(104),issuer:'Synthetic county',jurisdiction:'Fixture',canonicalUrl:'https://example.gov/notice',rawText:'Synthetic seed.',publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:'available',contentPermission:'full_text'},{id:id(105),retrievedAt:'2026-10-12T07:00:00Z'}).version;
  await fixture.seed(seed,actor,'incident_commander');
  await fixture.db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,'replay',$4,$5,$6)`,[id(107),scope.organizationId,scope.incidentId,JSON.stringify({schemaVersion:1,sources:[{documentId:id(103),documentKey:id(103),canonicalUrl:'https://example.gov/notice',issuer:'Synthetic county',jurisdiction:'Fixture',contentPermission:'full_text'}]}),'b'.repeat(64),actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1 where mode='replay'",[id(107)]);
  const warmup=(await admitRun({incidentId:scope.incidentId,mode:'replay',sourceConfigRevision:id(107),commandId:id(108)})).run;
  const lease=await acquireRunLease({scope:replayScope,runId:warmup.id,owner:id(110)});
  const version=prepareDocumentVersion({scope:replayScope,documentId:id(103),sourceConfigRevision:id(107),issuer:'Synthetic county',jurisdiction:'Fixture',canonicalUrl:'https://example.gov/notice',rawText:text,publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:'available',contentPermission:'full_text'},{id:id(111),retrievedAt:new Date().toISOString()}).version;
  const pub=await publishEvidence({scope:replayScope,runId:warmup.id,owner:id(110),fence:lease.run.fence,commandId:id(112),observations:[{documentId:id(103),requestedAt:warmup.createdAt,observedBytes:Buffer.byteLength(text),providerRequestId:null,outcome:'observed',version}]});
  await cancelRun({incidentId:scope.incidentId,mode:'replay',runId:warmup.id,commandId:id(113)});
  await recordPolicy({incidentId:scope.incidentId,mode:'replay',commandId:id(114),expectedPolicyRevision:null,expectedSourceConfiguration:id(107),expectedEvidenceGeneration:pub.receipt.evidenceGeneration,configuration:{schemaVersion:1,inputBasis:'demo',evaluationAt:new Date(Date.now()-(future?3600000:0)).toISOString(),note:'Synthetic recorded corpus scenario.',documentRules:[{documentId:id(103),maxAgeMinutes:1440,requirePublicationTime:false,requireEffectiveInterval:false}],nativeRules:[{sourceKey:'tiger-roads',maxAgeMinutes:1440,requireProviderTime:false,requireValidUntil:false}]}});
  const run=(await admitRun({incidentId:scope.incidentId,mode:'replay',sourceConfigRevision:id(107),commandId:id(115)})).run;calls=[];await execute(run.id);
  expect(await status(run.id)).toMatchObject({status:future?'failed':'completed',tavily_requests:0,model_requests:future?0:2});expect(calls.every(c=>c.url.includes('tokenfactory'))).toBe(true);
 });
});
