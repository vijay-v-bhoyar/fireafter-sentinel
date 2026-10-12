import {createHash} from 'node:crypto';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect} from 'vitest';
import {sentinelEvidenceSqlFixture} from '@/test/sentinel-evidence-sql-fixture';
import {prepareDocumentVersion} from './evidence';
const id=(n:number)=>`76000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),incidentId:id(2),mode:'live'},s=[scope.organizationId,scope.incidentId,scope.mode],actor=id(9),owner=id(10);
const v=prepareDocumentVersion({scope,documentId:id(3),sourceConfigRevision:id(4),issuer:'Synthetic county',jurisdiction:'Fixture',canonicalUrl:'https://example.gov/notice',rawText:'Synthetic source.',publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:'available',contentPermission:'full_text'},{id:id(5),retrievedAt:'2026-10-12T08:00:00Z'}).version;
let fixture:Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>,run:{id:string;fence:number;deadlineAt:string};
beforeAll(async()=>{fixture=await sentinelEvidenceSqlFixture();},20000);
beforeEach(async()=>{
 await fixture.db.exec('begin');await fixture.seed(v,actor,'analyst');
 await fixture.db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)`,[id(7),...s,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:'fixture',issuer:'Synthetic county',jurisdiction:'Fixture',canonicalUrl:'https://example.gov/notice',contentPermission:'full_text'}]}),'a'.repeat(64),actor]);
 await fixture.db.query('update public.sentinel_incident_state set current_source_config_revision=$1',[id(7)]);
 run=(await fixture.rpc<{run:typeof run}>('sentinel_admit_run',[actor,...s,id(7),id(8)])).run;
});
afterEach(async()=>{await fixture.db.exec('rollback');});afterAll(async()=>{await fixture?.close();});
async function lease(){run=(await fixture.rpc<{run:typeof run}>('sentinel_acquire_run_lease',[...s,run.id,owner])).run;return run;}
async function save(sequence=0,kind='context',frame='{"fixture":true}',state='retrieving'){return fixture.rpc('sentinel_save_worker_output',[...s,run.id,owner,run.fence,sequence,kind,frame,createHash('sha256').update(frame).digest('hex'),state]);}
describe('applied worker dispatch/output boundaries, embedded synthetic DB',()=>{
 it('claims one logical dispatch under replay and records a single exact runtime receipt',async()=>{
  expect(await fixture.rpc('sentinel_claim_dispatch',[run.id,id(20),null,false])).toEqual({attemptId:id(20),dispatchId:run.id});
  expect(await fixture.rpc('sentinel_claim_dispatch',[run.id,id(21),null,false])).toBeNull();
  expect(await fixture.rpc('sentinel_ack_dispatch',[run.id,id(20),'wrun_fixture'])).toBe(true);
  expect(await fixture.rpc('sentinel_ack_dispatch',[run.id,id(20),'wrun_fixture'])).toBe(true);
  await expect(fixture.rpc('sentinel_ack_dispatch',[run.id,id(20),'wrun_other'])).rejects.toMatchObject({code:'23505'});
 });
 it('keeps the original deadline and counters when a lost scheduler response becomes retryable',async()=>{
  await fixture.rpc('sentinel_claim_dispatch',[run.id,id(20),null,false]);
  // Fixture owner simulates the elapsed retry delay; no production reset API exists.
  await fixture.db.exec('alter table public.sentinel_dispatch_attempts disable trigger sentinel_dispatch_attempts_immutable');
  await fixture.db.query(`update public.sentinel_dispatch_attempts set created_at=created_at-interval '16 seconds' where id=$1`,[id(20)]);
  await fixture.db.exec('alter table public.sentinel_dispatch_attempts enable trigger sentinel_dispatch_attempts_immutable');
  expect(await fixture.rpc('sentinel_claim_dispatch',[run.id,id(21),id(20),false])).toEqual({attemptId:id(21),dispatchId:run.id});
  const state=await fixture.rpc<{run:{deadlineAt:string;usage:{modelRequests:number}}}>('sentinel_dispatch_state',[run.id]);expect(state.run.deadlineAt).toBe(run.deadlineAt);expect(state.run.usage.modelRequests).toBe(0);
 });
 it('rechecks original actor membership before dispatch or private worker lookup',async()=>{
  await fixture.db.exec("update public.organization_members set role='viewer'");await expect(fixture.rpc('sentinel_worker_locator',[run.id])).rejects.toMatchObject({code:'42501'});await expect(fixture.rpc('sentinel_claim_dispatch',[run.id,id(20),null,false])).rejects.toMatchObject({code:'42501'});
 });
 it('reads a scoped typed context and appends only a contiguous hash-bound output under a valid lease',async()=>{
  await lease();const ctx=await fixture.rpc<{run:{id:string};configuration:{sources:unknown[]};outputs:unknown[]}>('sentinel_read_worker',[...s,run.id,owner,run.fence]);expect(ctx.run.id).toBe(run.id);expect(ctx.configuration.sources).toHaveLength(1);expect(ctx.outputs).toEqual([]);
  await expect(save(1)).rejects.toMatchObject({code:'40001'});expect(await save()).toBe(true);
  const leaseState=(await fixture.db.query<{lease_owner:string|null}>('select lease_owner from public.sentinel_runs where id=$1',[run.id])).rows[0];expect(leaseState.lease_owner).toBeNull();
  await lease();expect(await save()).toBe(true);await expect(save(0,'context','{"fixture":false}')).rejects.toMatchObject({code:'23505'});
 });
 it('rejects arbitrary payload hashes, stale scope and late workers',async()=>{
  await lease();await expect(fixture.rpc('sentinel_save_worker_output',[...s,run.id,owner,run.fence,0,'context','{}','0'.repeat(64),'retrieving'])).rejects.toMatchObject({code:'22023'});
  await expect(fixture.rpc('sentinel_read_worker',[id(99),scope.incidentId,scope.mode,run.id,owner,run.fence])).rejects.toMatchObject({code:'42501'});
  await expect(fixture.rpc('sentinel_read_worker',[...s,run.id,id(99),run.fence])).rejects.toMatchObject({code:'40001'});
 });
 it('cannot append to a retired configuration but can safely terminate the old run as failed',async()=>{
  await lease();await fixture.db.exec('update public.sentinel_incident_state set current_source_config_revision=null');await expect(save()).rejects.toMatchObject({code:'40001'});await expect(fixture.rpc('sentinel_finish_worker',[...s,run.id,owner,run.fence,'completed','published'])).rejects.toMatchObject({code:'40001'});expect(await fixture.rpc('sentinel_finish_worker',[...s,run.id,owner,run.fence,'failed','configuration_changed'])).toMatchObject({status:'failed'});
 });
 it('does not call a saved changes-shaped blob a completed pipeline without actual source extraction',async()=>{
  await lease();await expect(fixture.rpc('sentinel_finish_worker',[...s,run.id,owner,run.fence,'completed','published'])).rejects.toMatchObject({code:'40001'});
  await save(0,'changes','{"changeIds":[]}','retrieving');await lease();await expect(fixture.rpc('sentinel_finish_worker',[...s,run.id,owner,run.fence,'completed','published'])).rejects.toMatchObject({code:'40001'});
 });
 it('cannot grant raw worker or dispatch table access to runtime',async()=>{
  await lease();await fixture.db.exec('savepoint private_output;set role service_role');await expect(fixture.db.exec('select * from public.sentinel_worker_outputs')).rejects.toMatchObject({code:'42501'});await fixture.db.exec('rollback to savepoint private_output;release savepoint private_output');
  await fixture.db.exec('savepoint private_dispatch;set role service_role');await expect(fixture.db.exec('select * from public.sentinel_dispatch_attempts')).rejects.toMatchObject({code:'42501'});await fixture.db.exec('rollback to savepoint private_dispatch;release savepoint private_dispatch');
 });
 it('refuses retention of worker artifacts when source rights allow only excerpts',async()=>{
  await fixture.rpc('sentinel_cancel_run',[actor,...s,run.id,id(70)]);
  await fixture.db.query(`insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)`,[id(71),...s,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),issuer:'Synthetic county',jurisdiction:'Fixture',canonicalUrl:'https://example.gov/notice',contentPermission:'excerpt_only'}]}),'a'.repeat(64),actor]);
  await fixture.db.query('update public.sentinel_incident_state set current_source_config_revision=$1',[id(71)]);
  run=(await fixture.rpc<{run:typeof run}>('sentinel_admit_run',[actor,...s,id(71),id(72)])).run;await lease();await expect(save()).rejects.toMatchObject({code:'22023'});
  expect((await fixture.db.query('select * from public.sentinel_worker_outputs')).rows).toHaveLength(0);
 });
});
