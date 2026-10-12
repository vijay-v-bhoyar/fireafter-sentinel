import {signSyntheticNativeFixture} from "../../test/sentinel-native-fixture";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sentinelEvidenceSqlFixture } from "../../test/sentinel-evidence-sql-fixture";
import { prepareDocumentVersion } from "./evidence";
import { recordConstraints } from "./constraints";
import { previewPlanDraft, createPlanDraft } from "./plans";
import { publishEvidence } from "./publication";
import { publishClaims } from "./claims";
import { recordClaimReview } from "./claim-reviews";
import { evidenceHash } from "./evidence";

import { GET, POST } from "../../app/api/sentinel/policy/route";
import { POST as ADMISSION } from "../../app/api/sentinel/plans/admission/route";
import { recordPolicy, readPolicy, previewPlanAdmission } from "./policies";
import { publishChanges } from "./changes";
import { readMarkerReview, recordMarkerReview } from "./marker-reviews";
const identity = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("../auth", () => ({ getCurrentUser: async () => identity.user }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
  const keyMap: Record<string,string[]> = {
    sentinel_record_policy:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_command_id","p_expected_policy","p_expected_source","p_expected_generation","p_configuration"],
    sentinel_read_policy:["p_actor_id","p_organization_id","p_incident_id","p_mode"],
    sentinel_preview_plan_admission:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_revision_id"],
    sentinel_publish_changes:["p_organization_id","p_incident_id","p_mode","p_run_id","p_owner","p_fence","p_command_id","p_expected_generation","p_changes"],
    sentinel_read_marker_review:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_marker_id"],
    sentinel_record_marker_review:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_marker_id","p_command_id","p_review"],
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
const id = (n: number) => `c1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9);
const seeded = prepareDocumentVersion({ scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic county", jurisdiction: "Fixture county", canonicalUrl: "https://example.gov/notice",
  rawText: "Synthetic source.", publishedAt: null, effectiveFrom: null, effectiveUntil: null, availability: "available", contentPermission: "full_text" }, { id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
let fixture: Awaited<ReturnType<typeof sentinelEvidenceSqlFixture>>;
let scenarioAt: number;
const at = (minutes: number) => new Date(scenarioAt + minutes * 60_000).toISOString();
function configuration() { return { schemaVersion: 1, shift: { startsAt: at(0), endsAt: at(480) }, inputBasis: "demo",
  crews: [{ id: id(10), label: "Demo crew", capabilities: ["road"], availableFrom: at(0), availableUntil: at(480) }],
  tasks: [1, 2, 3].map(n => ({ id: id(20 + n), assetId: id(100 + n), label: `Demo inspection ${n}`, taskType: "inspection", requiredCapability: "road",
    durationMinutes: 60, travelMinutes: 15, windowFrom: at(0), windowUntil: at(480), priority: n })) }; }
function command() { return { incidentId: scope.incidentId, mode: scope.mode, commandId: id(40), expectedConstraintRevision: null as string | null, configuration: configuration() }; }
beforeAll(async () => { fixture = await sentinelEvidenceSqlFixture(); }, 20_000);
beforeEach(async () => {
  scenarioAt = Math.floor(Date.now()/60_000)*60_000 + 5*60_000;
  await fixture.db.exec("begin"); await fixture.seed(seeded, actor, "incident_commander"); identity.user = { id: actor, organizationId: scope.organizationId, role: "incident_commander" };
  for (let n = 1; n <= 3; n++) await fixture.db.query("insert into public.assets(id,incident_id,name,asset_type,location_label,source,confidence) values($1,$2,$3,'road','Fixture','synthetic','High')", [id(100 + n), scope.incidentId, `Synthetic asset ${n}`]);
  await recordConstraints(command());
  await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) values($1,$2,$3,$4,$5,$6,$7)",
    [id(44),scope.organizationId,scope.incidentId,scope.mode,JSON.stringify({schemaVersion:1,sources:[{documentId:id(3),documentKey:id(3),canonicalUrl:"https://example.gov/notice",issuer:"Synthetic county",jurisdiction:"Fixture county",contentPermission:"full_text"}]}),"a".repeat(64),actor]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1",[id(44)]);
});
afterEach(async () => { await fixture.db.exec("rollback"); }); afterAll(async () => { await fixture?.close(); });
async function state() { return (await fixture.db.query<{ evidence_generation: number; unresolved_source_change_count: number; current_constraint_revision: string | null }>("select evidence_generation,unresolved_source_change_count,current_constraint_revision from public.sentinel_incident_state")).rows[0]; }
function previewInput(){return {incidentId:scope.incidentId,mode:scope.mode,taskDependencies:[1,2,3].map(n=>({taskId:id(20+n),claimIds:[] as string[]}))};}
async function draftCommand(commandId=id(60)){
 const input=previewInput(),preview=await previewPlanDraft(input);
 return {...input,commandId,expectedCurrentPlanRevision:preview.currentPlanRevision,expectedConstraintRevision:preview.constraintRevision.id,
   expectedEvidenceGeneration:preview.evidenceGeneration,expectedEvidenceVectorHash:preview.evidenceVectorHash};
}
function policyConfiguration() { return { schemaVersion: 1, inputBasis: "demo", evaluationAt: at(0), note: "Synthetic coordinator policy, not agency validation.",
 documentRules: [{ documentId: id(3), maxAgeMinutes: 30, requirePublicationTime: true, requireEffectiveInterval: true }],
 nativeRules: [{ sourceKey: "nws-forecast", maxAgeMinutes: 30, requireProviderTime: true, requireValidUntil: true }] }; }
async function policyCommand(commandId=id(70),expectedPolicyRevision:string|null=null){return {incidentId:scope.incidentId,mode:scope.mode,commandId,expectedPolicyRevision,
 expectedSourceConfiguration:id(44),expectedEvidenceGeneration:(await state()).evidence_generation,configuration:policyConfiguration()};}
async function rawPolicy(c:Awaited<ReturnType<typeof policyCommand>>){return fixture.rpc("sentinel_record_policy",[actor,scope.organizationId,c.incidentId,c.mode,c.commandId,c.expectedPolicyRevision,c.expectedSourceConfiguration,c.expectedEvidenceGeneration,JSON.stringify(c.configuration)]);}
async function qualifiedEvidence(documentOverrides:Record<string,unknown>={}){
 const s=[scope.organizationId,scope.incidentId,scope.mode] as const,owner=id(50);
 const admitted=await fixture.rpc<{run:{id:string;fence:number;createdAt:string}}>("sentinel_admit_run",[actor,...s,id(44),id(51)]);
 const run=(await fixture.rpc<typeof admitted>("sentinel_acquire_run_lease",[...s,admitted.run.id,owner])).run;
 const v=prepareDocumentVersion({scope,documentId:id(3),sourceConfigRevision:id(44),issuer:"Synthetic county",jurisdiction:"Fixture county",canonicalUrl:"https://example.gov/notice",rawText:"Synthetic source.",
  publishedAt:at(-10),effectiveFrom:at(-60),effectiveUntil:at(540),availability:"available",contentPermission:"full_text",...documentOverrides},{id:id(1000),retrievedAt:new Date().toISOString()}).version;
 const pub=await publishEvidence({scope,runId:run.id,owner,fence:run.fence,commandId:id(52),observations:[{documentId:id(3),outcome:"observed",requestedAt:run.createdAt,observedBytes:17,providerRequestId:null,version:v}]});
 await publishClaims({scope,runId:run.id,owner,fence:run.fence,commandId:id(53),expectedEvidenceGeneration:pub.receipt.evidenceGeneration,versionIds:[v.id],claims:[{
  id:id(1001),documentVersionId:v.id,excerptStart:0,excerptEnd:17,excerpt:"Synthetic source.",excerptHash:evidenceHash("Synthetic source."),kind:"general_notice",claimText:"Synthetic notice.",
  entityIds:[id(101),id(102),id(103)],modelVersion:"synthetic",promptVersion:"synthetic"}]});
 const review=await recordClaimReview({incidentId:scope.incidentId,mode:scope.mode,claimId:id(1001),commandId:id(54),expectedEvidenceGeneration:pub.receipt.evidenceGeneration,expectedReviewId:null,
  support:"supported",applicability:"applicable",provenance:"verified",conflict:"clear",note:"Synthetic source context."});
 const markerId=pub.receipt.observations[0].markerId!;
 await publishChanges({scope,runId:run.id,owner,fence:run.fence,commandId:id(55),expectedEvidenceGeneration:review.receipt.evidenceGeneration,changes:[{
  id:id(56),markerId,category:"addition",materiality:"material",claimIds:[id(1001)],affectedEntityIds:[id(101),id(102),id(103)],explanation:"Synthetic source addition.",modelVersion:"synthetic",promptVersion:"synthetic"}]});
 const marker=await readMarkerReview(scope.incidentId,scope.mode,markerId);if(!marker)throw new Error("Fixture marker missing");
 await recordMarkerReview({incidentId:scope.incidentId,mode:scope.mode,markerId,commandId:id(57),expectedEvidenceGeneration:marker.evidenceGeneration,expectedReviewId:marker.latestReviewId,
  expectedReviewVectorHash:marker.reviewVectorHash,changeId:marker.latestChangeId,action:"resolve",materiality:"material",completeReview:true,provenance:"verified",note:"Synthetic full source reviewed."});
 await nativeSnapshot();return {run,owner,v};
}
async function nativeSnapshot(overrides:Record<string,unknown>={}){
 const payload={sourceKey:"nws-forecast",sentinelMode:"synthetic",dataOrigin:"synthetic",coverageStatus:"available",sourceTimeBasis:"provider",validUntil:at(60),...overrides};
 await fixture.db.query("insert into public.source_snapshots(id,incident_id,source_name,fetched_at,source_updated_at,status,stale,freshness_label,raw_payload) values($1,$2,'Synthetic NWS', $3,$4,'online',false,'Synthetic',$5)",[id(80),scope.incidentId,at(-1),at(-1),JSON.stringify(payload)]);
 await signSyntheticNativeFixture(fixture.db,scope,id(80));
}
async function preparedProposal(documentOverrides:Record<string,unknown>={}){await qualifiedEvidence(documentOverrides);const policy=await recordPolicy(await policyCommand());const c=await draftCommand();c.taskDependencies.forEach(v=>{v.claimIds=[id(1001)];});
 const preview=await previewPlanDraft({incidentId:c.incidentId,mode:c.mode,taskDependencies:c.taskDependencies});const saved=await createPlanDraft({...c,expectedEvidenceVectorHash:preview.evidenceVectorHash});return {policy,saved};}
const admissionInput=(planRevisionId:string)=>({incidentId:scope.incidentId,mode:scope.mode,planRevisionId});
const url="https://sentinel.example/api/sentinel/policy";
function request(body:unknown,headers:Record<string,string>={}){return new Request(url,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});}
describe("Immutable coordinator policy and post-lock evidence admission through real SQL",()=>{
 it("creates a policy, advances generation and records its source/configuration binding",async()=>{
  const c=await policyCommand(),out=await recordPolicy(c);expect(out.receipt.changed).toBe(true);expect(out.receipt.evidenceGeneration).toBe(c.expectedEvidenceGeneration+1);
  expect((await readPolicy(scope.incidentId,scope.mode))?.revision?.id).toBe(out.revision.id);expect(out.revision.sourceConfigurationId).toBe(id(44));
 });
 it("replays history after a later policy without reactivating it",async()=>{
  const c=await policyCommand(),first=await recordPolicy(c),next=await policyCommand(id(71),first.revision.id);next.configuration.note="Revised synthetic policy.";
  const second=await recordPolicy(next);expect((await recordPolicy(c)).replayed).toBe(true);expect((await readPolicy(scope.incidentId,scope.mode))?.revision?.id).toBe(second.revision.id);
  await expect(recordPolicy({...c,configuration:{...c.configuration,note:"Changed retry."}})).rejects.toMatchObject({code:"POLICY_CONFLICT"});
 });
 it("records a semantic no-op receipt without generation or pointer changes",async()=>{
  const first=await recordPolicy(await policyCommand()),c=await policyCommand(id(72),first.revision.id),again=await recordPolicy(c);
  expect(again.receipt.changed).toBe(false);expect(again.receipt.evidenceGeneration).toBe(c.expectedEvidenceGeneration);expect(again.revision.id).toBe(first.revision.id);
 });
 for(const role of ["analyst","viewer","deleted"]){it(`fresh SQL denies ${role} policy creation`,async()=>{
  const c=await policyCommand();if(role==="deleted")await fixture.db.query("delete from public.organization_members where user_id=$1",[actor]);
  else await fixture.db.query("update public.organization_members set role=$1 where user_id=$2",[role,actor]);
  await expect(recordPolicy(c)).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });}
 for(const field of ["expectedPolicyRevision","expectedSourceConfiguration","expectedEvidenceGeneration"] as const){it(`rejects stale ${field}`,async()=>{
  const c=await policyCommand();Object.assign(c,{[field]:field==="expectedEvidenceGeneration"?99:id(99)});
  await expect(recordPolicy(c)).rejects.toMatchObject({code:"POLICY_CONFLICT"});
 });}
 it("requires every registered document rule, with no foreign or duplicate IDs",async()=>{
  const c=await policyCommand();c.configuration.documentRules[0].documentId=id(999);await expect(recordPolicy(c)).rejects.toMatchObject({code:"INPUT_INVALID"});
  c.configuration.documentRules.push(c.configuration.documentRules[0]);await expect(recordPolicy(c)).rejects.toMatchObject({code:"INPUT_INVALID"});
 });
 for(const malformed of ["fraction","nullBasis","forecastFloor","badClock"]){it(`SQL independently rejects ${malformed}`,async()=>{
  const c=await policyCommand();if(malformed==="fraction")c.configuration.nativeRules[0].maxAgeMinutes=1.5;
  if(malformed==="nullBasis")Object.assign(c.configuration,{inputBasis:null});if(malformed==="forecastFloor")c.configuration.nativeRules[0].requireValidUntil=false;
  if(malformed==="badClock")c.configuration.evaluationAt="2026-02-30T08:00:00Z";await expect(rawPolicy(c)).rejects.toMatchObject({code:"22023"});
 });}
 it("returns explicit policy/claim/source blockers when evidence is incomplete",async()=>{
  const saved=await createPlanDraft(await draftCommand()),out=await previewPlanAdmission(admissionInput(saved.revision.id));
  expect(out?.eligible).toBe(false);expect(out?.blockers).toContain("policy_missing");expect(out?.blockers).toContain("task_evidence_missing");
 });
 it("qualifies complete synthetic evidence at the pinned clock while retaining draft authority",async()=>{
  const {saved,policy}=await preparedProposal();expect(saved.revision.policyRevisionId).toBe(policy.revision.id);
  const out=await previewPlanAdmission(admissionInput(saved.revision.id));expect(out?.blockers).toEqual([]);expect(out?.eligible).toBe(true);expect(out?.approvalReady).toBe(false);
  expect(out?.checkedAt).toBe(at(0));expect(out?.timeBasis).toBe("scenario");expect(out?.documentChecks[0].versionId).toBe(id(1000));expect(out?.nativeChecks[0].snapshotId).toBe(id(80));
 });
 it("uses the same snapshot fingerprint across different session timezones",async()=>{
  const {saved}=await preparedProposal();await fixture.db.query("select set_config('TimeZone','Asia/Kolkata',false)");
  const context=await previewPlanDraft({incidentId:scope.incidentId,mode:scope.mode,taskDependencies:saved.revision.taskDependencies});
  expect(context.evidenceVectorHash).toBe(saved.revision.evidenceVectorHash);expect((await previewPlanAdmission(admissionInput(saved.revision.id)))?.eligible).toBe(true);
 });
 it("uses the post-context database clock for live policy, never a caller-supplied scenario time",async()=>{
  const live={...scope,mode:"live" as const};await fixture.seed({...seeded,id:id(4100),scope:live},actor,"incident_commander");
  await fixture.db.query("insert into public.sentinel_source_configs(id,organization_id,incident_id,mode,configuration,config_hash,created_by) select id,organization_id,incident_id,'live',configuration,config_hash,created_by from public.sentinel_source_configs where id=$1 and mode='synthetic'",[id(44)]);
  await fixture.db.query("update public.sentinel_incident_state set current_source_config_revision=$1 where mode='live'",[id(44)]);
  const authored=await recordConstraints({...command(),mode:"live"});const config={...policyConfiguration(),inputBasis:"user_authored",evaluationAt:null};
  await recordPolicy({incidentId:scope.incidentId,mode:"live",commandId:id(470),expectedPolicyRevision:null,expectedSourceConfiguration:id(44),expectedEvidenceGeneration:authored.receipt.evidenceGeneration,configuration:config});
  const input={...previewInput(),mode:"live"},preview=await previewPlanDraft(input),saved=await createPlanDraft({...input,commandId:id(471),expectedCurrentPlanRevision:preview.currentPlanRevision,
   expectedConstraintRevision:preview.constraintRevision.id,expectedEvidenceGeneration:preview.evidenceGeneration,expectedEvidenceVectorHash:preview.evidenceVectorHash});
  const before=Date.now(),out=await previewPlanAdmission({incidentId:scope.incidentId,mode:"live",planRevisionId:saved.revision.id}),after=Date.now();
  expect(out?.timeBasis).toBe("database");expect(Date.parse(out!.checkedAt)).toBeGreaterThanOrEqual(before-1);expect(Date.parse(out!.checkedAt)).toBeLessThanOrEqual(after+1);
  expect(out?.eligible).toBe(false);
 });
 for(const [field,value,code] of [["publishedAt",null,"document_publication_unknown"],["publishedAt","future","document_publication_in_future"],
  ["effectiveFrom",null,"document_effective_unknown"],["effectiveUntil",null,"document_effective_unknown"],["effectiveUntil","boundary","document_not_effective"]] as const){
  it(`blocks document ${field}=${value}`,async()=>{
   const {saved}=await preparedProposal({[field]:value==="future"?at(1):value==="boundary"?at(0):value});
   expect((await previewPlanAdmission(admissionInput(saved.revision.id)))?.blockers).toContain(code);
  });
 }
 it("keeps explicit unknown dates when a commander policy does not require them",async()=>{
  await qualifiedEvidence({publishedAt:null,effectiveFrom:null,effectiveUntil:null});const c=await policyCommand();c.configuration.documentRules[0].requirePublicationTime=false;c.configuration.documentRules[0].requireEffectiveInterval=false;
  await recordPolicy(c);const command=await draftCommand();command.taskDependencies.forEach(v=>{v.claimIds=[id(1001)];});const p=await previewPlanDraft({incidentId:scope.incidentId,mode:scope.mode,taskDependencies:command.taskDependencies});
  const saved=await createPlanDraft({...command,expectedEvidenceVectorHash:p.evidenceVectorHash});expect((await previewPlanAdmission(admissionInput(saved.revision.id)))?.eligible).toBe(true);
  expect((await fixture.db.query<{published_at:string|null;effective_from:string|null;effective_until:string|null}>("select published_at,effective_from,effective_until from public.sentinel_document_versions where id=$1",[id(1000)])).rows[0]).toEqual({published_at:null,effective_from:null,effective_until:null});
 });
 it("holds a superseded proposal without changing its historical policy",async()=>{
  const {saved}=await preparedProposal(),c=await draftCommand(id(61));c.taskDependencies.forEach(v=>{v.claimIds=[id(1001)];});const p=await previewPlanDraft({incidentId:scope.incidentId,mode:scope.mode,taskDependencies:c.taskDependencies});
  await createPlanDraft({...c,expectedEvidenceVectorHash:p.evidenceVectorHash});expect((await previewPlanAdmission(admissionInput(saved.revision.id)))?.blockers).toContain("proposal_superseded");
 });
 it("holds changed constraints as a review issue instead of failing historical admission read",async()=>{
  const {saved}=await preparedProposal(),current=(await state()).current_constraint_revision!;const c=command();c.commandId=id(42);c.expectedConstraintRevision=current;c.configuration.tasks[0].label="Changed selected task.";
  await recordConstraints(c);expect((await previewPlanAdmission(admissionInput(saved.revision.id)))?.blockers).toContain("constraints_changed");
 });
 it("denies cross-scope and revoked admission reads without exposing the stored snapshot",async()=>{
  const {saved}=await preparedProposal();expect(await previewPlanAdmission({...admissionInput(saved.revision.id),incidentId:id(999)})).toBeNull();
  expect(await previewPlanAdmission({...admissionInput(saved.revision.id),mode:"live"})).toBeNull();
  await fixture.db.query("delete from public.organization_members where user_id=$1",[actor]);await expect(previewPlanAdmission(admissionInput(saved.revision.id))).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });
 it("allows a current viewer to inspect policy and admission without policy write authority",async()=>{
  const {saved}=await preparedProposal();identity.user={id:actor,organizationId:scope.organizationId,role:"viewer"};await fixture.db.query("update public.organization_members set role='viewer' where user_id=$1",[actor]);
  expect((await readPolicy(scope.incidentId,scope.mode))?.revision).not.toBeNull();expect((await previewPlanAdmission(admissionInput(saved.revision.id)))?.eligible).toBe(true);
  await expect(recordPolicy(await policyCommand())).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });
 it("policy history has no raw runtime read, update or deletion grant",async()=>{
  const policy=await recordPolicy(await policyCommand());await expect(fixture.db.query("delete from public.sentinel_policies where id=$1",[policy.revision.id])).rejects.toMatchObject({code:"55000"});
  await fixture.db.exec("rollback;begin;set role service_role");await expect(fixture.db.query("select * from public.sentinel_policies")).rejects.toMatchObject({code:"42501"});
  await fixture.db.exec("rollback;begin");
 });
 for(const [field,value,code] of [["sentinelMode","live","native_mode_unbound"],["dataOrigin","live","native_mode_unbound"],["validUntil",null,"native_validity_unknown"],
  ["validUntil","invalid","native_validity_invalid"],["validUntil","boundary","native_validity_expired"],["coverageStatus","not_available","native_coverage_unavailable"],["sourceTimeBasis","unknown","native_provider_time_unknown"]] as const){
  it(`blocks changed native ${field}=${value}`,async()=>{
   const {saved}=await preparedProposal();const replacement=value==="boundary"?at(0):value;
   await fixture.db.query("update public.source_snapshots set raw_payload=jsonb_set(raw_payload,$1,$2) where id=$3",[[field],JSON.stringify(replacement),id(80)]);
   const out=await previewPlanAdmission(admissionInput(saved.revision.id));expect(out?.eligible).toBe(false);expect(out?.blockers).toContain(code);expect(out?.blockers).toContain("evidence_changed");
  });
 }
 it("rejects native retrieval expiry at the exact boundary",async()=>{
  const {saved}=await preparedProposal();await fixture.db.query("update public.source_snapshots set fetched_at=$1 where id=$2",[at(-30),id(80)]);
  expect((await previewPlanAdmission(admissionInput(saved.revision.id)))?.blockers).toContain("native_check_expired");
 });
 it("rejects document expiry at the exact boundary without rewriting its version",async()=>{
  const {saved}=await preparedProposal();await fixture.db.query("insert into public.sentinel_retrieval_events(organization_id,incident_id,mode,document_id,source_config_revision,checked_version_id,requested_at,completed_at,outcome,observed_bytes) values($1,$2,$3,$4,$5,$6,$7,$7,'same_version',17)",[scope.organizationId,scope.incidentId,scope.mode,id(3),id(44),id(1000),at(-30)]);
  const out=await previewPlanAdmission(admissionInput(saved.revision.id));expect(out?.blockers).toContain("document_check_expired");expect(out?.blockers).toContain("evidence_changed");
 });
 it("latest failed recheck blocks the retained successful version",async()=>{
  const {saved}=await preparedProposal();await fixture.db.query("insert into public.sentinel_retrieval_events(organization_id,incident_id,mode,document_id,source_config_revision,requested_at,completed_at,outcome,observed_bytes) values($1,$2,$3,$4,$5,$6,$6,'failed',0)",[scope.organizationId,scope.incidentId,scope.mode,id(3),id(44),at(-1)]);
  expect((await previewPlanAdmission(admissionInput(saved.revision.id)))?.blockers).toContain("document_check_incomplete");
 });
 it("policy changes invalidate a prior proposal and require a new captured revision",async()=>{
  const {saved,policy}=await preparedProposal(),c=await policyCommand(id(73),policy.revision.id);c.configuration.note="New explicit clock/coverage policy.";await recordPolicy(c);
  const out=await previewPlanAdmission(admissionInput(saved.revision.id));expect(out?.blockers).toContain("policy_changed");expect(out?.blockers).toContain("evidence_changed");
 });
 it("private HTTP routes preserve guard behavior and never expose approval",async()=>{
  const response=await POST(request(await policyCommand()));expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");
  const read=await GET(new Request(`${url}?incidentId=${scope.incidentId}&mode=synthetic`));expect(read.status).toBe(200);
  const saved=await createPlanDraft(await draftCommand());const checked=await ADMISSION(new Request("https://sentinel.example/api/sentinel/plans/admission",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(admissionInput(saved.revision.id))}));
  expect(checked.status).toBe(200);expect((await checked.json()).approvalReady).toBe(false);
  expect((await POST(request({...await policyCommand(),actorId:id(999)}))).status).toBe(400);
  expect((await POST(request(await policyCommand(),{Origin:"https://attacker.example"}))).status).toBe(403);
 });
 it("retains immutable policy history and rolls back a failed receipt append",async()=>{
  await fixture.db.exec("create function public.reject_policy_command() returns trigger language plpgsql as $$ begin raise exception 'fixture failure';end;$$;create trigger reject_policy_command before insert on public.sentinel_policy_commands for each row execute function public.reject_policy_command()");
  await expect(recordPolicy(await policyCommand())).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_policies")).rows[0].n).toBe(0);
  expect((await fixture.db.query<{current_policy_revision:string|null}>("select current_policy_revision from public.sentinel_incident_state")).rows[0].current_policy_revision).toBeNull();
 });
});
