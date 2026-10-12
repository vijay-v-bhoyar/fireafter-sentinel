import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion } from "./evidence";
import { recordConstraints } from "./constraints";
import { previewPlanDraft, createPlanDraft, readPlanDraft } from "./plans";
import { publishEvidence } from "./publication";
import { publishClaims } from "./claims";
import { recordClaimReview } from "./claim-reviews";
import { evidenceHash } from "./evidence";
import { proposeTaskAssignments } from "./planning";
import { GET, POST } from "../../app/api/sentinel/plans/route";
import { POST as PREVIEW } from "../../app/api/sentinel/plans/preview/route";
import { GET as HISTORY } from "../../app/api/sentinel/plans/[revision]/route";
const identity = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("../auth", () => ({ getCurrentUser: async () => identity.user }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
  const keyMap: Record<string,string[]> = {
    sentinel_record_constraints:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_command_id","p_expected_revision","p_configuration"],
    sentinel_read_plan_context:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_dependencies"],
    sentinel_find_plan_command:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_command_id","p_command"],
    sentinel_create_plan_draft:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_command_id","p_expected_parent","p_expected_constraint","p_expected_generation","p_expected_vector","p_dependencies","p_allocation"],
    sentinel_read_plan_draft:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_revision_id"],
    sentinel_publish_evidence:["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_observations"],
    sentinel_publish_claims:["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_expected_generation","p_version_ids","p_claims","p_transient_texts"],
    sentinel_record_claim_review:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_claim_id","p_command_id","p_review"]
  };const keys=keyMap[name];if(!keys)throw new Error("Unknown fixture RPC");
  try { return { data: await fixture.rpc(name, keys.map(k => typeof args[k] === "object" && args[k] !== null ? JSON.stringify(args[k]) : args[k])), error: null }; }
  catch (error) { return { data: null, error }; }
} }) }));
const id = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9);
const seeded = prepareDocumentVersion({ scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic county", jurisdiction: "Fixture county", canonicalUrl: "https://example.gov/notice",
  rawText: "Synthetic source.", publishedAt: null, effectiveFrom: null, effectiveUntil: null, availability: "available", contentPermission: "full_text" }, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 8, minutes)).toISOString();
function configuration() { return { schemaVersion: 1, shift: { startsAt: at(0), endsAt: at(480) }, inputBasis: "demo",
  crews: [{ id: id(10), label: "Demo crew", capabilities: ["road"], availableFrom: at(0), availableUntil: at(480) }],
  tasks: [1, 2, 3].map(n => ({ id: id(20 + n), assetId: id(100 + n), label: `Demo inspection ${n}`, taskType: "inspection", requiredCapability: "road",
    durationMinutes: 60, travelMinutes: 15, windowFrom: at(0), windowUntil: at(480), priority: n })) }; }
function command() { return { incidentId: scope.incidentId, mode: scope.mode, commandId: id(40), expectedConstraintRevision: null as string | null, configuration: configuration() }; }
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  await fixture.db.exec("begin"); await fixture.seed(seeded, actor, "analyst"); identity.user = { id: actor, organizationId: scope.organizationId, role: "analyst" };
  for (let n = 1; n <= 3; n++) await fixture.db.query("insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,$3,'road','Fixture','synthetic','High')", [id(100 + n), scope.incidentId, `Synthetic asset ${n}`]);
  await recordConstraints(command());
});
afterEach(async () => { await fixture.db.exec("rollback"); }); afterAll(async () => { await fixture?.close(); });
async function state() { return (await fixture.db.query<{ evidence_generation: number; unresolved_source_change_count: number; current_constraint_revision: string | null }>("select evidence_generation,unresolved_source_change_count,current_constraint_revision from public.sentinel_incident_state")).rows[0]; }
function previewInput(){return {incidentId:scope.incidentId,mode:scope.mode,taskDependencies:[1,2,3].map(n=>({taskId:id(20+n),claimIds:[] as string[]}))};}
async function draftCommand(commandId=id(60)){
 const input=previewInput(),preview=await previewPlanDraft(input);
 return {...input,commandId,expectedCurrentPlanRevision:preview.currentPlanRevision,expectedConstraintRevision:preview.constraintRevision.id,
   expectedEvidenceGeneration:preview.evidenceGeneration,expectedEvidenceVectorHash:preview.evidenceVectorHash};
}
async function rawProposal(c:Awaited<ReturnType<typeof draftCommand>>,allocation:unknown){return fixture.rpc("sentinel_create_plan_draft",[actor,scope.organizationId,scope.incidentId,scope.mode,c.commandId,c.expectedCurrentPlanRevision,c.expectedConstraintRevision,c.expectedEvidenceGeneration,c.expectedEvidenceVectorHash,JSON.stringify(c.taskDependencies),JSON.stringify(allocation)]);}
const url="https://sentinel.example/api/sentinel/plans";
function request(path:string,body:unknown,headers:Record<string,string>={}){return new Request(url+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});}
describe("Immutable scoped proposal drafts and snapshot fencing through real SQL",()=>{
 it("previews complete allocation with explicit missing policy/source blockers",async()=>{
  const p=await previewPlanDraft(previewInput());expect(p.allocation.status).toBe("feasible");expect(p.approvalReady).toBe(false);
  expect(p.blockers).toContain("policy_not_qualified");expect(p.blockers).toContain("task_evidence_missing");expect(p.evidenceSnapshot.assets).toHaveLength(3);
 });
 it("persists every selected item and its exact snapshot without approving a plan",async()=>{
  const c=await draftCommand(),result=await createPlanDraft(c);expect(result).toMatchObject({replayed:false,revision:{state:"draft",approvalReady:false,scope,constraintRevisionId:c.expectedConstraintRevision},receipt:{state:"draft",evidenceVectorHash:c.expectedEvidenceVectorHash}});
  expect(result.revision.allocation.assignments).toHaveLength(3);
  expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_plan_items")).rows[0].n).toBe(3);
  expect(await readPlanDraft(scope.incidentId,scope.mode)).toMatchObject({isCurrentRevision:true,snapshotMatchesCurrent:true,validity:"needs_review",approvalReady:false,revision:result.revision});
 });
 it("keeps history and exact replay after a later proposal without moving the current pointer",async()=>{
  const c=await draftCommand(),first=await createPlanDraft(c),second=await createPlanDraft(await draftCommand(id(61)));
  expect(second.revision.parentRevisionId).toBe(first.revision.id);expect(second.revision.planId).toBe(first.revision.planId);
  expect(await createPlanDraft(c)).toEqual({...first,replayed:true});expect((await readPlanDraft(scope.incidentId,scope.mode))?.revision.id).toBe(second.revision.id);
  expect(await readPlanDraft(scope.incidentId,scope.mode,first.revision.id)).toMatchObject({isCurrentRevision:false,revision:first.revision});
  await expect(createPlanDraft({...c,taskDependencies:c.taskDependencies.map(v=>({...v,claimIds:[id(999)]}))})).rejects.toMatchObject({code:"PLAN_CONFLICT"});
 });
 it.each(["expectedCurrentPlanRevision","expectedConstraintRevision","expectedEvidenceGeneration","expectedEvidenceVectorHash"])("rejects stale %s without saving",async key=>{
  const c=await draftCommand();await expect(createPlanDraft({...c,[key]:key==="expectedEvidenceGeneration"?99:key==="expectedEvidenceVectorHash"?"b".repeat(64):id(999)})).rejects.toMatchObject({code:"PLAN_CONFLICT"});
  expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_plan_revisions")).rows[0].n).toBe(0);
 });
 it("asset changes invalidate the fingerprint even without a Sentinel generation change",async()=>{
  const c=await draftCommand();await fixture.db.exec("update public.assets set name='Changed authored asset' where name='Synthetic asset 1'");
  expect((await state()).evidence_generation).toBe(c.expectedEvidenceGeneration);await expect(createPlanDraft(c)).rejects.toMatchObject({code:"PLAN_CONFLICT"});
 });
 it("native snapshot changes invalidate preview rather than being called unchanged evidence",async()=>{
  const c=await draftCommand();await fixture.db.query("insert into public.source_snapshots(incident_id,source_name,fetched_at,status,stale,freshness_label) values($1,'synthetic_weather',clock_timestamp(),'offline',true,'Unknown')",[scope.incidentId]);
  await expect(createPlanDraft(c)).rejects.toMatchObject({code:"PLAN_CONFLICT"});
 });
 it("changes to constraints preserve the old revision and require a new proposal",async()=>{
  const first=await createPlanDraft(await draftCommand());const cfg=configuration();cfg.tasks[0].durationMinutes=90;
  await recordConstraints({...command(),commandId:id(41),expectedConstraintRevision:first.revision.constraintRevisionId,configuration:cfg});
  expect(await readPlanDraft(scope.incidentId,scope.mode,first.revision.id)).toMatchObject({snapshotMatchesCurrent:false,revision:first.revision});
 });
 it.each(["viewer","deleted"])("fresh SQL role denies %s creation and replay",async role=>{
  const c=await draftCommand();await createPlanDraft(c);await fixture.db.exec(role==="deleted"?"delete from public.organization_members":"update public.organization_members set role='viewer'");
  await expect(createPlanDraft(c)).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });
 it.each(["viewer","analyst","incident_commander"])("allows current %s scoped draft/history reads",async role=>{
  const result=await createPlanDraft(await draftCommand());await fixture.db.query("update public.organization_members set role=$1",[role]);expect((await readPlanDraft(scope.incidentId,scope.mode,result.revision.id))?.revision.id).toBe(result.revision.id);
 });
 it("does not expose other incident/mode/revision rows",async()=>{
  await createPlanDraft(await draftCommand());expect(await readPlanDraft(id(999),scope.mode)).toBeNull();expect(await readPlanDraft(scope.incidentId,"replay")).toBeNull();expect(await readPlanDraft(scope.incidentId,scope.mode,id(999))).toBeNull();
 });
 it("rejects incomplete dependency mappings and foreign claim IDs",async()=>{
  await expect(previewPlanDraft({...previewInput(),taskDependencies:previewInput().taskDependencies.slice(1)})).rejects.toMatchObject({code:"INPUT_INVALID"});
  const input=previewInput();input.taskDependencies[0].claimIds=[id(999)];await expect(previewPlanDraft(input)).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });
 it("retains all selected items even when authored estimates are missing",async()=>{
  const current=await state();const cfg=configuration() as unknown as Record<string,unknown>;const tasks=cfg.tasks as Array<Record<string,unknown>>;tasks[0].durationMinutes=null;
  await recordConstraints({...command(),commandId:id(41),expectedConstraintRevision:current.current_constraint_revision,configuration:cfg});
  const result=await createPlanDraft(await draftCommand());expect(result.revision.allocation.status).toBe("incomplete");expect(result.revision.allocation.assignments).toEqual([]);
  expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_plan_items")).rows[0].n).toBe(3);
 });
 it.each(["partial","overlap","wrongCrew","wrongWindow"])("SQL independently rejects forged feasible %s allocation",async kind=>{
  const c=await draftCommand(),preview=await previewPlanDraft(previewInput()),a=structuredClone(preview.allocation);
  if(kind==="partial")a.assignments.pop();else if(kind==="overlap")a.assignments[1].startsAt=a.assignments[0].startsAt;else if(kind==="wrongCrew")a.assignments[0].crewId=id(999);else a.assignments[0].startsAt=at(450);
  await expect(rawProposal(c,a)).rejects.toMatchObject({code:"22023"});
 });
 it("keeps history readable when a current selected asset was removed",async()=>{
  const first=await createPlanDraft(await draftCommand());await fixture.db.exec("delete from public.assets");
  expect(await readPlanDraft(scope.incidentId,scope.mode,first.revision.id)).toMatchObject({snapshotMatchesCurrent:false,revision:first.revision});
  await expect(previewPlanDraft(previewInput())).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });
 it("rolls back revision/items/current pointer when receipt append fails",async()=>{
  await fixture.db.exec("create function public.fail_test_plan_receipt() returns trigger language plpgsql as $$ begin raise exception 'synthetic receipt failure';end $$;create trigger plan_receipt_fail before insert on public.sentinel_plan_commands for each row execute function public.fail_test_plan_receipt()");
  await expect(createPlanDraft(await draftCommand())).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});expect(await readPlanDraft(scope.incidentId,scope.mode)).toBeNull();
  expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_plan_items")).rows[0].n).toBe(0);
 });
 it("HTTP previews, saves, reads current and reads exact history with private headers",async()=>{
  const previewResponse=await PREVIEW(request('/preview',previewInput()));expect(previewResponse.status).toBe(200);
  const resultResponse=await POST(request('',await draftCommand()));expect(resultResponse.status).toBe(200);const result=await resultResponse.json();
  const read=await GET(new Request(`${url}?incidentId=${scope.incidentId}&mode=synthetic`));expect(read.status).toBe(200);
  const history=await HISTORY(new Request(`${url}/${result.revision.id}?incidentId=${scope.incidentId}&mode=synthetic`),{params:Promise.resolve({revision:result.revision.id})});expect(history.status).toBe(200);
  for(const response of [previewResponse,resultResponse,read,history]){expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("x-content-type-options")).toBe("nosniff");}
  expect((await POST(request('',{...await draftCommand(id(61)),actorId:actor}))).status).toBe(400);expect((await POST(request('',await draftCommand(id(61)),{Origin:"https://attacker.example"}))).status).toBe(403);
 });
 it("denies raw writes/deletion of immutable plan history",async()=>{
  await createPlanDraft(await draftCommand());for(const name of ['sentinel_plans','sentinel_plan_revisions','sentinel_plan_items','sentinel_plan_commands']){
   await fixture.db.exec("savepoint plan_immutable");await expect(fixture.db.exec(`delete from public.${name}`)).rejects.toBeDefined();await fixture.db.exec("rollback to savepoint plan_immutable;release savepoint plan_immutable");
  }
  await fixture.db.exec("savepoint plan_role;set role service_role");await expect(fixture.db.exec("select * from public.sentinel_plan_revisions")).rejects.toMatchObject({code:"42501"});await fixture.db.exec("rollback to savepoint plan_role;reset role;release savepoint plan_role");
 });
 it("captures real scoped claim/version/review lineage rather than accepting arbitrary IDs",async()=>{
  await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
   [id(44),scope.organizationId,scope.incidentId,scope.mode,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),canonicalUrl:'https://example.gov/notice',issuer:'Synthetic county',jurisdiction:'Fixture county',contentPermission:'full_text'}]}),'a'.repeat(64),actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1",[id(44)]);
  const s=[scope.organizationId,scope.incidentId,scope.mode] as const,owner=id(50);
  const admitted=await fixture.rpc<{run:{id:string;fence:number;createdAt:string}}>('sentinel_admit_run',[actor,...s,id(44),id(51)]);
  const run=(await fixture.rpc<typeof admitted>('sentinel_acquire_run_lease',[...s,admitted.run.id,owner])).run;
  const v=prepareDocumentVersion({scope,documentId:id(3),sourceConfigRevision:id(44),issuer:'Synthetic county',jurisdiction:'Fixture county',canonicalUrl:'https://example.gov/notice',rawText:'Synthetic source.',publishedAt:null,effectiveFrom:null,effectiveUntil:null,availability:'available',contentPermission:'full_text'},{id:id(1000),retrievedAt:new Date().toISOString()}).version;
  const out=await publishEvidence({scope,runId:run.id,owner,fence:run.fence,commandId:id(52),observations:[{documentId:id(3),outcome:'observed',requestedAt:run.createdAt,observedBytes:17,providerRequestId:null,version:v}]});
  await publishClaims({scope,runId:run.id,owner,fence:run.fence,commandId:id(53),expectedEvidenceGeneration:out.receipt.evidenceGeneration,versionIds:[v.id],claims:[{id:id(1001),documentVersionId:v.id,excerptStart:0,excerptEnd:17,excerpt:'Synthetic source.',excerptHash:evidenceHash('Synthetic source.'),kind:'general_notice',claimText:'Synthetic notice.',entityIds:[id(101)],modelVersion:'synthetic',promptVersion:'synthetic'}]});
  const reviewed=await recordClaimReview({incidentId:scope.incidentId,mode:scope.mode,claimId:id(1001),commandId:id(54),expectedEvidenceGeneration:out.receipt.evidenceGeneration,expectedReviewId:null,support:'supported',applicability:'applicable',provenance:'verified',conflict:'clear',note:'Synthetic source context.'});
  const input=previewInput();input.taskDependencies[0].claimIds=[id(1001)];const p=await previewPlanDraft(input);
  const result=await createPlanDraft({...input,commandId:id(60),expectedCurrentPlanRevision:p.currentPlanRevision,expectedConstraintRevision:p.constraintRevision.id,expectedEvidenceGeneration:p.evidenceGeneration,expectedEvidenceVectorHash:p.evidenceVectorHash});
  expect(result.revision.approvalReady).toBe(false);const dependency=(await fixture.db.query<{claim_id:string;version_id:string;claim_review_id:string}>('select claim_id,version_id,claim_review_id from public.sentinel_plan_dependencies')).rows[0];
  expect(dependency).toEqual({claim_id:id(1001),version_id:v.id,claim_review_id:reviewed.review.id});
 });
});
