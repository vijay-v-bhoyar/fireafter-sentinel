import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion, evidenceHash } from "./evidence";
import { publishEvidence } from "./publication";
import { publishClaims } from "./claims";
import { publishChanges, readChangePage } from "./changes";
import { GET } from "../../app/api/sentinel/changes/route";
const identity=vi.hoisted(()=>({user:null as unknown}));
vi.mock("../auth",()=>({getCurrentUser:async()=>identity.user}));
vi.mock("../supabase",()=>({getSupabaseAdminClient:()=>({rpc:async(name:string,args:Record<string,unknown>)=>{
  const keys=name==="sentinel_publish_changes"?["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_expected_generation","p_changes"]
    :name==="sentinel_read_changes"?["p_actor_id","p_organization_id","p_incident_id","p_mode","p_after_sequence"]
    :name==="sentinel_publish_claims"?["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_expected_generation","p_version_ids","p_claims","p_transient_texts"]
    :["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_observations"];
  try{return {data:await fixture.rpc(name,keys.map(k=>typeof args[k]==="object"?JSON.stringify(args[k]):args[k])),error:null};}catch(error){return {data:null,error};}
}})}));
const id=(n:number)=>`93000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope={organizationId:id(1),incidentId:id(2),mode:"synthetic" as const},actor=id(9),owner=id(10),s=[scope.organizationId,scope.incidentId,scope.mode] as const;
const base={scope,documentId:id(3),sourceConfigRevision:id(4),issuer:"Synthetic county",jurisdiction:"Fixture county",canonicalUrl:"https://example.gov/notice",
  rawText:"Synthetic road closes today. More supporting text.",publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:"available",contentPermission:"full_text"};
const seeded=prepareDocumentVersion(base,{id:id(5),retrievedAt:"2026-10-11T10:00:00Z"}).version;
let fixture:Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>,run:{id:string;fence:number;createdAt:string},version:typeof seeded,generation:number,markerId:string;
beforeAll(async()=>{fixture=await sentinelEvidenceSqlFixture();},20_000);
beforeEach(async()=>{
  await fixture.db.exec("begin");await fixture.seed(seeded,actor,"analyst");identity.user={id:actor,organizationId:scope.organizationId,role:"analyst"};
  await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
    [id(44),...s,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),canonicalUrl:base.canonicalUrl,issuer:base.issuer,jurisdiction:base.jurisdiction,contentPermission:"full_text"}]}),"a".repeat(64),actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1",[id(44)]);
  const admitted=await fixture.rpc<{run:typeof run}>("sentinel_admit_run",[actor,...s,id(44),id(11)]);run=(await fixture.rpc<typeof admitted>("sentinel_acquire_run_lease",[...s,admitted.run.id,owner])).run;
  version=prepareDocumentVersion({...base,sourceConfigRevision:id(44)},{id:id(100),retrievedAt:new Date().toISOString()}).version;
  await observe(version,id(80));
  await fixture.db.query("insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,'Synthetic road','road','Fixture','synthetic','High')",[id(500),scope.incidentId]);
  await publishClaims({scope,runId:run.id,owner,fence:run.fence,commandId:id(81),expectedEvidenceGeneration:generation,versionIds:[version.id],claims:[{
    id:id(200),documentVersionId:version.id,excerptStart:0,excerptEnd:27,excerpt:"Synthetic road closes today",excerptHash:evidenceHash("Synthetic road closes today"),kind:"road_status",
    claimText:"Synthetic road closes today",entityIds:[id(500)],modelVersion:"synthetic",promptVersion:"synthetic"}]});
});
afterEach(async()=>{await fixture.db.exec("rollback");});afterAll(async()=>{await fixture?.close();});
async function observe(v:typeof seeded,commandId:string){const out=await publishEvidence({scope,runId:run.id,owner,fence:run.fence,commandId,observations:[{
  documentId:id(3),outcome:"observed",requestedAt:run.createdAt,observedBytes:v.normalizedBytes,providerRequestId:null,version:v}]});generation=out.receipt.evidenceGeneration;markerId=out.receipt.observations[0].markerId!;}
function draft(n=300){return {id:id(n),markerId,category:"addition",materiality:"material",claimIds:[id(200)],affectedEntityIds:[id(500)],
  explanation:"Synthetic initial notice requires review.",modelVersion:"synthetic-not-live",promptVersion:"synthetic-comparison-v1"};}
function command(n=400){return {scope,runId:run.id,owner,fence:run.fence,commandId:id(n),expectedEvidenceGeneration:generation,changes:[draft()]};}
async function raw(changes:unknown,expected=generation){return fixture.rpc("sentinel_publish_changes",[...s,run.id,owner,run.fence,id(400),expected,JSON.stringify(changes)]);}
async function state(){return (await fixture.db.query<{evidence_generation:number;unresolved_source_change_count:number}>("select evidence_generation,unresolved_source_change_count from public.sentinel_incident_state")).rows[0];}

describe("Durable comparison drafts with exact SQL and member HTTP projection",()=>{
  it("retains server-bound addition lineage without resolving or approving anything",async()=>{
    const result=await publishChanges(command());expect(result).toMatchObject({replayed:false,receipt:{changeIds:[id(300)],markerIds:[markerId],semanticAccepted:false,unresolvedSourceChanges:1}});
    expect(await readChangePage(scope.incidentId,scope.mode)).toMatchObject({classificationPendingMarkers:0,unresolvedSourceChanges:1,items:[{isLatestDraft:true,currentEvidence:true,
      change:{...draft(),scope,runId:run.id,versionId:version.id,documentId:id(3),previousVersionId:null,stage:"draft",semanticAccepted:false}}]});
    expect(await state()).toEqual({evidence_generation:generation,unresolved_source_change_count:1});
  });
  it("distinguishes no draft from no source change",async()=>{expect(await readChangePage(scope.incidentId,scope.mode)).toMatchObject({items:[],classificationPendingMarkers:1,unresolvedSourceChanges:1});});
  it("permits a zero-citation uncertain comparison without declaring zero changes",async()=>{
    await publishChanges({...command(),changes:[{...draft(),category:"unresolved",materiality:"unresolved",claimIds:[],affectedEntityIds:[]}]});
    expect((await readChangePage(scope.incidentId,scope.mode))?.items[0].change.materiality).toBe("unresolved");expect((await state()).unresolved_source_change_count).toBe(1);
  });
  it("exact replay retains receipt and changed payload conflicts",async()=>{
    const c=command(),first=await publishChanges(c);expect(await publishChanges(c)).toEqual({...first,replayed:true});
    await expect(publishChanges({...c,changes:[{...draft(),explanation:"Changed"}]})).rejects.toMatchObject({code:"CHANGE_CONFLICT"});
    expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_changes")).rows[0].n).toBe(1);
  });
  it("later drafts supersede only the current draft label and preserve history",async()=>{
    await publishChanges(command());await publishChanges({...command(401),changes:[{...draft(301),category:"unresolved",materiality:"unresolved"}]});
    const page=await readChangePage(scope.incidentId,scope.mode);expect(page?.items.map(v=>v.isLatestDraft)).toEqual([false,true]);expect(page?.unresolvedSourceChanges).toBe(1);
  });
  it.each(["viewer","deleted"])("fresh membership denies %s worker publication and replay",async role=>{
    const c=command();await publishChanges(c);await fixture.db.exec(role==="deleted"?"delete from public.organization_members":"update public.organization_members set role='viewer'");
    await expect(publishChanges(c)).rejects.toMatchObject({code:"SCOPE_DENIED"});
  });
  it.each([{fence:99},{owner:id(999)},{expectedEvidenceGeneration:99}])("rejects stale worker/generation %j",async patch=>{
    await expect(publishChanges({...command(),...patch})).rejects.toMatchObject({code:"CHANGE_CONFLICT"});
  });
  it.each(["expired","canceled"])("rejects %s leases",async kind=>{
    await fixture.db.exec(kind==="expired"?"update public.sentinel_runs set lease_until=clock_timestamp()-interval '1 second'":"update public.sentinel_runs set status='canceled'");
    await expect(publishChanges(command())).rejects.toMatchObject({code:"CHANGE_CONFLICT"});
  });
  it.each([{markerId:id(999)},{claimIds:[id(999)]},{affectedEntityIds:[id(999)]}])("rejects foreign references %j atomically",async patch=>{
    await expect(raw([{...draft(),...patch}])).rejects.toMatchObject({code:"42501"});expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_changes")).rows[0].n).toBe(0);
  });
  it.each([{semanticAccepted:true},{stage:"approved"},{category:"supersession"},{category:"benign",materiality:"benign"},
    {category:"conflict"},{category:"withdrawal"},{claimIds:[]},{claimIds:[id(200),id(200)]},{affectedEntityIds:[id(500),id(500)]},{explanation:""},{modelVersion:""}])("rejects invalid raw drafts %j",async patch=>{
    await expect(raw([{...draft(),...patch}])).rejects.toMatchObject({code:"22023"});
  });
  it("checks all batch references before retaining any result",async()=>{
    await expect(raw([draft(),{...draft(301),markerId:id(999)}])).rejects.toBeDefined();expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_changes")).rows[0].n).toBe(0);
  });
  it("marks old drafts historical after a new source version",async()=>{
    await publishChanges(command());const v=prepareDocumentVersion({...base,sourceConfigRevision:id(44),rawText:"Synthetic road now opens."},{id:id(101),retrievedAt:new Date().toISOString()}).version;
    await observe(v,id(82));expect((await readChangePage(scope.incidentId,scope.mode))?.items[0].currentEvidence).toBe(false);
    await publishChanges({...command(401),changes:[{...draft(301),category:"substantive",explanation:"Synthetic update compared with previous cited notice."}]});
    const page=await readChangePage(scope.incidentId,scope.mode);expect(page?.items[1].change.previousVersionId).toBe(version.id);expect(page?.items[1].currentEvidence).toBe(true);expect(page?.unresolvedSourceChanges).toBe(2);
  });
  it("checks withdrawal metadata before allowing a zero-citation withdrawal draft",async()=>{
    const v=prepareDocumentVersion({...base,sourceConfigRevision:id(44),availability:"withdrawn",rawText:""},{id:id(101),retrievedAt:new Date().toISOString()}).version;
    await observe(v,id(82));await publishChanges({...command(),changes:[{...draft(),category:"withdrawal",claimIds:[],affectedEntityIds:[]}]});
    expect((await readChangePage(scope.incidentId,scope.mode))?.items[0].change.category).toBe("withdrawal");expect((await state()).unresolved_source_change_count).toBe(2);
  });
  it("rechecks referenced assets after extraction",async()=>{await fixture.db.exec("delete from public.assets");await expect(publishChanges(command())).rejects.toMatchObject({code:"SCOPE_DENIED"});});
  it("rejects a real scoped citation outside the marker's old/new version pair",async()=>{
    await fixture.db.query("insert into public.sentinel_claims(organization_id,incident_id,mode,id,document_version_id,run_id,publication_command_id,excerpt_start,excerpt_end,excerpt,body,created_at) select organization_id,incident_id,mode,$1::uuid,$2::uuid,run_id,publication_command_id,excerpt_start,excerpt_end,excerpt,body||jsonb_build_object('id',$1::uuid::text,'documentVersionId',$2::uuid::text),created_at from public.sentinel_claims",[id(201),seeded.id]);
    await expect(publishChanges({...command(),changes:[{...draft(),claimIds:[id(201)]}]})).rejects.toMatchObject({code:"SCOPE_DENIED"});
  });
  it("does not silently call different issuers benign or substantive",async()=>{
    await fixture.db.exec("update public.sentinel_runs set status='canceled',lease_owner=null,lease_until=null");
    const issuer="Different synthetic issuer";
    await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
      [id(45),...s,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),canonicalUrl:base.canonicalUrl,issuer,jurisdiction:base.jurisdiction,contentPermission:"full_text"}]}),"b".repeat(64),actor]);
    await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1",[id(45)]);
    const admitted=await fixture.rpc<{run:typeof run}>("sentinel_admit_run",[actor,...s,id(45),id(12)]);run=(await fixture.rpc<typeof admitted>("sentinel_acquire_run_lease",[...s,admitted.run.id,owner])).run;
    const v=prepareDocumentVersion({...base,sourceConfigRevision:id(45),issuer},{id:id(101),retrievedAt:new Date().toISOString()}).version;
    await observe(v,id(82));
    await expect(publishChanges({...command(),changes:[{...draft(),category:"benign",materiality:"benign"}]})).rejects.toMatchObject({code:"INPUT_INVALID"});
    await expect(publishChanges({...command(),changes:[{...draft(),category:"substantive"}]})).rejects.toMatchObject({code:"INPUT_INVALID"});
    expect((await publishChanges({...command(),changes:[{...draft(),category:"conflict",materiality:"unresolved"}]})).receipt.semanticAccepted).toBe(false);
  });
  it("does not permit runtime updates or deletes of draft history",async()=>{
    await publishChanges(command());
    for(const operation of ["update public.sentinel_changes set body='{}'","delete from public.sentinel_changes","delete from public.sentinel_change_publications"]){
      await fixture.db.exec("savepoint immutable_probe");await expect(fixture.db.exec(operation)).rejects.toBeDefined();await fixture.db.exec("rollback to savepoint immutable_probe;release savepoint immutable_probe");
    }
  });
  it.each(["viewer","analyst","incident_commander"])("permits current %s member read",async role=>{await fixture.db.query("update public.organization_members set role=$1",[role]);expect(await readChangePage(scope.incidentId,scope.mode)).toMatchObject({items:[]});});
  it("denies revoked reads and returns null for unknown incident/mode",async()=>{
    expect(await readChangePage(id(999),scope.mode)).toBeNull();expect(await readChangePage(scope.incidentId,"replay")).toBeNull();await fixture.db.exec("delete from public.organization_members");await expect(readChangePage(scope.incidentId,scope.mode)).rejects.toMatchObject({code:"SCOPE_DENIED"});
  });
  it("pages 26 retained drafts using server append sequence and a scoped cursor",async()=>{
    for(let i=0;i<26;i++)await publishChanges({...command(400+i),changes:[draft(300+i)]});
    const url=`https://sentinel.example/api/sentinel/changes?incidentId=${scope.incidentId}&mode=synthetic`,first=await GET(new Request(url));expect(first.status).toBe(200);
    const page=await first.json();expect(page.items).toHaveLength(25);expect(page.hasMore).toBe(true);expect(page.nextAfterSequence).toBeUndefined();
    const second=await GET(new Request(`${url}&cursor=${page.nextCursor}`));const next=await second.json();expect(next.items).toHaveLength(1);expect(next.hasMore).toBe(false);
    expect(first.headers.get("cache-control")).toBe("private, no-store");expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await GET(new Request(`${url.replace("synthetic","live")}&cursor=${page.nextCursor}`))).status).toBe(400);
  });
  it("rolls back result and receipt if the lease expires during persistence",async()=>{
    await fixture.db.exec("create function public.delay_test_change() returns trigger language plpgsql as $$ begin perform pg_sleep(0.20);return new;end $$;create trigger slow_change before insert on public.sentinel_changes for each row execute function public.delay_test_change();update public.sentinel_runs set lease_until=clock_timestamp()+interval '0.10 second'");
    await expect(publishChanges(command())).rejects.toMatchObject({code:"CHANGE_CONFLICT"});expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_changes")).rows[0].n).toBe(0);
  });
  it("denies raw table access and grants RPC only to service_role",async()=>{
    for(const role of ["anon","authenticated","service_role"]){const result=await fixture.db.query<{allowed:boolean}>("select has_function_privilege($1,'public.sentinel_publish_changes(uuid,uuid,text,uuid,uuid,bigint,uuid,bigint,jsonb)','EXECUTE') allowed",[role]);expect(result.rows[0].allowed).toBe(role==="service_role");}
    await fixture.db.exec("savepoint raw_access;set role service_role");await expect(fixture.db.exec("select * from public.sentinel_changes")).rejects.toMatchObject({code:"42501"});await fixture.db.exec("rollback to savepoint raw_access;reset role;release savepoint raw_access");
  });
});
