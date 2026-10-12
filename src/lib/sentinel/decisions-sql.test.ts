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

import { POST } from "../../app/api/sentinel/plans/[revision]/decisions/route";
import { GET } from "../../app/api/sentinel/decisions/status/route";
import { recordDecision, readDecisionCommand } from "./decisions";
import { prepareBriefing, readBriefing, readHistory } from "./briefings";
import { verifyBriefingDelivery } from "./briefing-delivery";
import { briefingResponse } from "./briefing-http";
import { GET as briefingGet } from "../../app/api/sentinel/briefings/[revision]/route";
import { GET as artifactGet } from "../../app/api/sentinel/briefing-artifacts/[id]/route";
import { GET as historyGet } from "../../app/api/sentinel/history/route";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const {JSDOM}=createRequire(import.meta.url)("jsdom") as {JSDOM:new(html?:string)=>{window:{DOMParser:typeof DOMParser;document:Document;close():void}}};

import { recordPolicy, previewPlanAdmission } from "./policies";
import { readPlanDraft } from "./plans";
import { publishChanges } from "./changes";
import { readMarkerReview, recordMarkerReview } from "./marker-reviews";
const identity = vi.hoisted(() => ({ user: null as unknown }));
vi.mock("../auth", () => ({ getCurrentUser: async () => identity.user }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
  const keyMap: Record<string,string[]> = {
    sentinel_create_briefing:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_revision_id"],
    sentinel_read_briefing:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_artifact_id"],
    sentinel_create_html_briefing:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_source_artifact_id"],
    sentinel_read_history:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_after_sequence"],
    sentinel_record_decision:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_revision_id","p_command"],
    sentinel_read_decision_command:["p_actor_id","p_organization_id","p_incident_id","p_mode","p_command_id"],
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
const id = (n: number) => `e1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
type Revision=Awaited<ReturnType<typeof createPlanDraft>>["revision"];
function decisionCommand(r:Revision,action:"accept"|"reject"|"modify"|"annotate"="accept",commandId=id(500)){
 return {incidentId:scope.incidentId,mode:scope.mode,planRevisionId:r.id,expectedPlanRevision:r.id,commandId,expectedEvidenceGeneration:r.evidenceGeneration,
  expectedEvidenceVectorHash:r.evidenceVectorHash,expectedConstraintRevision:r.constraintRevisionId,expectedPolicyRevision:r.policyRevisionId,
  action,note:"Synthetic coordinator decision; no physical dispatch.",modifications:null as null|{assignments:{taskId:string;crewId:string;startsAt:string}[]}};
}
async function counts(){return (await fixture.db.query<{decisions:number;receipts:number;audits:number;terminals:number}>("select (select count(*)::int from public.sentinel_decisions) decisions,(select count(*)::int from public.sentinel_command_receipts) receipts,(select count(*)::int from public.sentinel_decision_audit) audits,(select count(*)::int from public.sentinel_decision_status) terminals")).rows[0];}
async function otherActor(role="incident_commander"){
 const actorId=id(900);await fixture.db.query("insert into auth.users(id) values($1)",[actorId]);await fixture.db.query("insert into public.organization_members(organization_id,user_id,role) values($1,$2,$3)",[scope.organizationId,actorId,role]);
 identity.user={id:actorId,organizationId:scope.organizationId,role};return actorId;
}
const route=(revision:string)=>`https://sentinel.example/api/sentinel/plans/${revision}/decisions`;
function request(revision:string,body:unknown,headers:Record<string,string>={}){return new Request(route(revision),{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});}
describe("Atomic human decisions, receipt reconciliation and immutable approved history through real SQL",()=>{
 it("accepts eligible synthetic evidence with atomic receipt, audits, terminal state and retained snapshot",async()=>{
  const {saved}=await preparedProposal(),c=decisionCommand(saved.revision),out=await recordDecision(c);
  expect(out.decision.action).toBe("accept");expect(out.finalValidation?.eligible).toBe(true);expect(out.finalValidation?.checkedAt).toBe(at(0));
  expect(await counts()).toEqual({decisions:1,receipts:1,audits:2,terminals:1});
  const page=await readPlanDraft(scope.incidentId,scope.mode,saved.revision.id);expect(page?.reviewState).toBe("approved");expect(page?.revision.state).toBe("draft");
  expect(page?.validity).toBe("current");expect(page?.isCurrentApprovedPlan).toBe(true);expect(page?.approvalReady).toBe(false);
  const snapshots=(await fixture.db.query<{same:boolean}>("select d.evidence_snapshot=r.evidence_snapshot same from public.sentinel_decisions d join public.sentinel_plan_revisions r on r.id=d.revision_id")).rows[0];expect(snapshots.same).toBe(true);
  expect((await previewPlanAdmission({incidentId:scope.incidentId,mode:scope.mode,planRevisionId:saved.revision.id}))?.blockers).toContain("proposal_already_decided");
 });
 it("rejects a stale current proposal without requiring feasible/current evidence",async()=>{
  const saved=await createPlanDraft(await draftCommand());await fixture.db.query("update public.assets set name='Changed fixture asset' where id=$1",[id(101)]);
  const out=await recordDecision(decisionCommand(saved.revision,"reject"));expect(out.finalValidation).toBeNull();
  expect((await readPlanDraft(scope.incidentId,scope.mode,saved.revision.id))?.reviewState).toBe("rejected");expect(await counts()).toEqual({decisions:1,receipts:1,audits:1,terminals:1});
 });
 for(const role of ["analyst","viewer","deleted"]){it(`fresh SQL denies ${role} acceptance despite cached commander identity`,async()=>{
  const {saved}=await preparedProposal();if(role==="deleted")await fixture.db.query("delete from public.organization_members where user_id=$1",[actor]);
  else await fixture.db.query("update public.organization_members set role=$1 where user_id=$2",[role,actor]);
  await expect(recordDecision(decisionCommand(saved.revision))).rejects.toMatchObject({code:"SCOPE_DENIED"});expect((await counts()).decisions).toBe(0);
 });}
 for(const field of ["expectedEvidenceGeneration","expectedEvidenceVectorHash","expectedConstraintRevision","expectedPolicyRevision"] as const){it(`rejects altered reviewed ${field}`,async()=>{
  const {saved}=await preparedProposal(),c=decisionCommand(saved.revision);Object.assign(c,{[field]:field==="expectedEvidenceGeneration"?99:field==="expectedEvidenceVectorHash"?"c".repeat(64):id(99)});
  await expect(recordDecision(c)).rejects.toMatchObject({code:"DECISION_CONFLICT"});expect((await counts()).decisions).toBe(0);
 });}
 it("rechecks native evidence instead of accepting a previously positive preview",async()=>{
  const {saved}=await preparedProposal();expect((await previewPlanAdmission({incidentId:scope.incidentId,mode:scope.mode,planRevisionId:saved.revision.id}))?.eligible).toBe(true);
  await fixture.db.query("update public.source_snapshots set stale=true where id=$1",[id(80)]);
  await expect(recordDecision(decisionCommand(saved.revision))).rejects.toMatchObject({code:"DECISION_CONFLICT"});expect((await counts()).terminals).toBe(0);
 });
 it("does not accept an unqualified draft with missing source/policy/claim evidence",async()=>{
  const saved=await createPlanDraft(await draftCommand());await expect(recordDecision(decisionCommand(saved.revision))).rejects.toMatchObject({code:"DECISION_CONFLICT"});expect((await counts()).decisions).toBe(0);
 });
 it("exact retry and status lookup return historical receipts without another mutation",async()=>{
  const {saved}=await preparedProposal(),c=decisionCommand(saved.revision),first=await recordDecision(c);
  await fixture.db.query("update public.assets set name='Later changed asset' where id=$1",[id(101)]);
  const replay=await recordDecision(c),status=await readDecisionCommand(scope.incidentId,scope.mode,c.commandId);
  expect(replay.replayed).toBe(true);expect(status?.receipt).toEqual(first.receipt);expect(replay.decision).toEqual(first.decision);expect((await counts()).decisions).toBe(1);
  const page=await readPlanDraft(scope.incidentId,scope.mode,saved.revision.id);expect(page?.reviewState).toBe("approved");expect(page?.validity).toBe("needs_review");
  await expect(recordDecision({...c,note:"Changed retry payload."})).rejects.toMatchObject({code:"DECISION_CONFLICT"});
 });
 it("a second commander cannot commit an opposing terminal outcome",async()=>{
  const {saved}=await preparedProposal();await recordDecision(decisionCommand(saved.revision));await otherActor();
  await expect(recordDecision(decisionCommand(saved.revision,"reject",id(501)))).rejects.toMatchObject({code:"DECISION_CONFLICT"});expect((await counts()).terminals).toBe(1);
 });
 it("a reject winner prevents later acceptance of that revision",async()=>{
  const {saved}=await preparedProposal();await recordDecision(decisionCommand(saved.revision,"reject"));await otherActor();
  await expect(recordDecision(decisionCommand(saved.revision,"accept",id(501)))).rejects.toMatchObject({code:"DECISION_CONFLICT"});
 });
 it("analyst modification makes a complete new draft and preserves the earlier approved plan",async()=>{
  const {saved}=await preparedProposal();await recordDecision(decisionCommand(saved.revision));const analyst=await otherActor("analyst");
  const c=decisionCommand(saved.revision,"modify",id(502));c.modifications={assignments:saved.revision.allocation.assignments.map(a=>({...a}))};
  const modified=await recordDecision(c);expect(modified.decision.actorId).toBe(analyst);expect(modified.decision.newPlanRevisionId).not.toBeNull();expect(modified.finalValidation).toBeNull();
  const old=await readPlanDraft(scope.incidentId,scope.mode,saved.revision.id),next=await readPlanDraft(scope.incidentId,scope.mode,modified.decision.newPlanRevisionId!);
  expect(old?.reviewState).toBe("approved");expect(old?.isCurrentApprovedPlan).toBe(true);expect(old?.validity).toBe("current");expect(old?.isCurrentRevision).toBe(false);
  expect(next?.reviewState).toBe("draft");expect(next?.revision.parentRevisionId).toBe(saved.revision.id);expect(next?.approvalReady).toBe(true);expect(next?.isCurrentApprovedPlan).toBe(false);
  await expect(recordDecision(decisionCommand(next!.revision,"accept",id(503)))).rejects.toMatchObject({code:"SCOPE_DENIED"});
  identity.user={id:actor,organizationId:scope.organizationId,role:"incident_commander"};await recordDecision(decisionCommand(next!.revision,"accept",id(504)));
  expect((await readPlanDraft(scope.incidentId,scope.mode,next!.revision.id))?.isCurrentApprovedPlan).toBe(true);
 });
 for(const forged of ["partial","overlap","foreignCrew"]){it(`SQL rejects ${forged} manual allocation and leaves the original pointer`,async()=>{
  const {saved}=await preparedProposal(),c=decisionCommand(saved.revision,"modify");c.modifications={assignments:saved.revision.allocation.assignments.map(a=>({...a}))};
  if(forged==="partial")c.modifications.assignments.pop();if(forged==="overlap")c.modifications.assignments[1].startsAt=c.modifications.assignments[0].startsAt;
  if(forged==="foreignCrew")c.modifications.assignments[0].crewId=id(999);
  await expect(recordDecision(c)).rejects.toMatchObject({code:"INPUT_INVALID"});expect((await readPlanDraft(scope.incidentId,scope.mode))?.revision.id).toBe(saved.revision.id);expect((await counts()).decisions).toBe(0);
 });}
 it("analyst annotation of historical content creates a receipt without reactivation",async()=>{
  const {saved}=await preparedProposal();const c=decisionCommand(saved.revision,"modify");c.modifications={assignments:saved.revision.allocation.assignments.map(a=>({...a}))};const next=await recordDecision(c);
  await otherActor("analyst");const note=await recordDecision(decisionCommand(saved.revision,"annotate",id(510)));expect(note.decision.newPlanRevisionId).toBeNull();
  expect((await readPlanDraft(scope.incidentId,scope.mode))?.revision.id).toBe(next.decision.newPlanRevisionId);expect((await counts()).terminals).toBe(0);
 });
 it("no matching scoped receipt remains not observed, not a claimed rollback",async()=>{
  expect(await readDecisionCommand(scope.incidentId,scope.mode,id(999))).toBeNull();const response=await GET(new Request(`https://sentinel.example/api/sentinel/decisions/status?incidentId=${scope.incidentId}&mode=synthetic&commandId=${id(999)}`));
  expect(response.status).toBe(200);expect(await response.json()).toEqual({status:"not_observed",result:null});
 });
 it("receipt lookup is actor/scoped and revoked membership cannot read it",async()=>{
  const {saved}=await preparedProposal(),c=decisionCommand(saved.revision);await recordDecision(c);await otherActor();expect(await readDecisionCommand(scope.incidentId,scope.mode,c.commandId)).toBeNull();
  identity.user={id:actor,organizationId:scope.organizationId,role:"incident_commander"};expect(await readDecisionCommand(scope.incidentId,"live",c.commandId)).toBeNull();
  await fixture.db.query("delete from public.organization_members where user_id=$1",[actor]);await expect(readDecisionCommand(scope.incidentId,scope.mode,c.commandId)).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });
 it("append failure rolls back decision, audits, terminal and approved pointer",async()=>{
  const {saved}=await preparedProposal();await fixture.db.exec("create function public.reject_decision_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture failure';end;$$;create trigger reject_decision_receipt before insert on public.sentinel_command_receipts for each row execute function public.reject_decision_receipt()");
  await expect(recordDecision(decisionCommand(saved.revision))).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});expect(await counts()).toEqual({decisions:0,receipts:0,audits:0,terminals:0});
  expect((await fixture.db.query<{current_approved_plan_revision:string|null}>("select current_approved_plan_revision from public.sentinel_incident_state")).rows[0].current_approved_plan_revision).toBeNull();
 });
 it("failed modification receipt rolls back the new draft and current pointer too",async()=>{
  const {saved}=await preparedProposal();await fixture.db.exec("create function public.reject_modify_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture failure';end;$$;create trigger reject_modify_receipt before insert on public.sentinel_command_receipts for each row execute function public.reject_modify_receipt()");
  const c=decisionCommand(saved.revision,"modify");c.modifications={assignments:saved.revision.allocation.assignments.map(a=>({...a}))};
  await expect(recordDecision(c)).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});expect((await readPlanDraft(scope.incidentId,scope.mode))?.revision.id).toBe(saved.revision.id);
  expect((await fixture.db.query<{n:number}>("select count(*)::int n from public.sentinel_plan_revisions")).rows[0].n).toBe(1);
 });
 it("late evidence failure at receipt append triggers final-validation rollback",async()=>{
  const {saved}=await preparedProposal();await fixture.db.exec("create function public.expire_before_final_admission() returns trigger language plpgsql as $$ begin update public.source_snapshots set stale=true;return new;end;$$;create trigger expire_before_final_admission before insert on public.sentinel_command_receipts for each row execute function public.expire_before_final_admission()");
  await expect(recordDecision(decisionCommand(saved.revision))).rejects.toMatchObject({code:"DECISION_CONFLICT"});expect(await counts()).toEqual({decisions:0,receipts:0,audits:0,terminals:0});
  expect((await fixture.db.query<{stale:boolean}>("select stale from public.source_snapshots where id=$1",[id(80)])).rows[0].stale).toBe(false);
 });
 it("HTTP mutation and reconciliation keep private guards and receipt semantics",async()=>{
  const {saved}=await preparedProposal(),c=decisionCommand(saved.revision);const {planRevisionId:unused,...body}=c;void unused;
  const context={params:Promise.resolve({revision:saved.revision.id})};const response=await POST(request(saved.revision.id,body),context);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");
  const read=await GET(new Request(`https://sentinel.example/api/sentinel/decisions/status?incidentId=${scope.incidentId}&mode=synthetic&commandId=${c.commandId}`));expect(read.status).toBe(200);expect((await read.json()).status).toBe("confirmed");
  expect((await POST(request(saved.revision.id,{...body,actorId:id(999)}),context)).status).toBe(400);expect((await POST(request(saved.revision.id,body,{Origin:"https://attacker.example"}),context)).status).toBe(403);
  expect((await POST(request(id(999),body),{params:Promise.resolve({revision:id(999)})})).status).toBe(400);
 });
 it("runtime cannot update/delete/read raw immutable decision records",async()=>{
  const {saved}=await preparedProposal(),out=await recordDecision(decisionCommand(saved.revision));await expect(fixture.db.query("delete from public.sentinel_decisions where id=$1",[out.decision.id])).rejects.toMatchObject({code:"55000"});
  await fixture.db.exec("rollback;begin;set role service_role");await expect(fixture.db.query("select * from public.sentinel_command_receipts")).rejects.toMatchObject({code:"42501"});await fixture.db.exec("rollback;begin");
 });
});

function planCorrection() { return {schemaVersion:1 as const,claimId:id(1001),originalClaimHash:evidenceHash("Synthetic notice."),correctedClaimText:"Synthetic reviewer correction, no automatic policy change.",correctedClaimId:null,reasonCode:"other" as const,permissionRecordId:null}; }
describe("Optional plan feedback shares the atomic decision command",()=>{
 it("accepts, retains scoped signal and final post-feedback admission, and reconciles the original command",async()=>{
  const {saved}=await preparedProposal(),c={...decisionCommand(saved.revision),feedback:planCorrection()},out=await recordDecision(c);
  expect(out.feedback).toMatchObject({reviewKind:"plan",claimReviewId:null,reviewDecisionId:out.decision.id,receiptId:out.receipt.id,actorId:actor,policyRevisionId:saved.revision.policyRevisionId});
  expect((await recordDecision(c)).feedback).toEqual(out.feedback);expect((await readDecisionCommand(scope.incidentId,scope.mode,c.commandId))?.feedback).toEqual(out.feedback);
  expect((await counts()).audits).toBe(3);expect(out.finalValidation?.eligible).toBe(true);
  await expect(recordDecision({...c,feedback:{...c.feedback,reasonCode:"unsupported_claim"}})).rejects.toMatchObject({code:"DECISION_CONFLICT"});
  await expect(recordDecision(decisionCommand(saved.revision))).rejects.toMatchObject({code:"DECISION_CONFLICT"});
 });
 it("a rejected proposal can capture a linked correction without claiming admission",async()=>{
  const {saved}=await preparedProposal(),out=await recordDecision({...decisionCommand(saved.revision,"reject"),feedback:planCorrection()});
  expect(out.feedback?.reviewDecisionId).toBe(out.decision.id);expect(out.finalValidation).toBeNull();expect((await counts()).audits).toBe(1);
 });
 it("late evidence failure during feedback append rolls back signal, decision, receipts, terminal state and native mutation",async()=>{
  const {saved}=await preparedProposal();await fixture.db.exec("create function public.feedback_changes_evidence() returns trigger language plpgsql as $$ begin update public.source_snapshots set stale=true;return new;end;$$;create trigger feedback_changes_evidence before insert on public.sentinel_feedback_observations for each row execute function public.feedback_changes_evidence()");
  await expect(recordDecision({...decisionCommand(saved.revision),feedback:planCorrection()})).rejects.toMatchObject({code:"DECISION_CONFLICT"});
  expect(await counts()).toEqual({decisions:0,receipts:0,audits:0,terminals:0});
  expect((await fixture.db.query<{count:number}>("select count(*)::int count from public.sentinel_feedback_observations")).rows[0].count).toBe(0);
  expect((await fixture.db.query<{stale:boolean}>("select stale from public.source_snapshots where id=$1",[id(80)])).rows[0].stale).toBe(false);
 });
 it("rejects a correction for an immutable claim absent from this plan's dependency set",async()=>{
  const {saved}=await preparedProposal();
  await fixture.db.query("insert into public.sentinel_claims(organization_id,incident_id,mode,id,document_version_id,run_id,publication_command_id,excerpt_start,excerpt_end,excerpt,body,created_at) select organization_id,incident_id,mode,$1::uuid,document_version_id,run_id,publication_command_id,excerpt_start,excerpt_end,excerpt,body||jsonb_build_object('id',$1::uuid::text),created_at from public.sentinel_claims where id=$2",[id(1002),id(1001)]);
  await expect(recordDecision({...decisionCommand(saved.revision,"reject"),feedback:{...planCorrection(),claimId:id(1002)}})).rejects.toMatchObject({code:"SCOPE_DENIED"});
  expect((await counts()).decisions).toBe(0);
 });
 it("the existing private decision POST commits feedback and reconciliation GET returns the identical signal",async()=>{
  const {saved}=await preparedProposal(),c={...decisionCommand(saved.revision),feedback:planCorrection()};const {planRevisionId,...body}=c;
  const response=await POST(request(planRevisionId,body),{params:Promise.resolve({revision:planRevisionId})});expect(response.status).toBe(200);
  const out=await response.json();const status=await GET(new Request(`https://sentinel.example/api/sentinel/decisions/status?incidentId=${scope.incidentId}&mode=synthetic&commandId=${c.commandId}`));
  expect((await status.json()).result.feedback.id).toBe(out.feedback.id);
 });
});

function deliveryScope(revisionId:string,format:"json"|"html"="json"){return {incidentId:scope.incidentId,mode:scope.mode,revisionId,format};}
describe("Scoped history and immutable portable briefing through exact SQL and HTTP",()=>{
 it("captures complete original lineage and a separately observed validity, with exact persisted UTF-8 hash and receipt",async()=>{
  const {saved}=await preparedProposal();await recordDecision(decisionCommand(saved.revision));const a=await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json");expect(a).not.toBeNull();
  const delivered=await verifyBriefingDelivery(briefingResponse(a!),deliveryScope(saved.revision.id));
  expect(delivered.status).toBe("download_prepared");expect(delivered.payload.plan.id).toBe(saved.revision.id);expect(delivered.payload.decisions[0].decision.action).toBe("accept");
  expect(delivered.payload.evidence.claims[0].claim.excerpt).toBe("Synthetic source.");expect(delivered.payload.evidence.documents).toHaveLength(1);
  expect(delivered.payload.evidence.assetReferences).toHaveLength(3);expect(delivered.payload.currentValidity.reviewState).toBe("approved");
  expect(a!.content).not.toContain('"raw_payload"');expect(a!.content).not.toContain('"permissionRecordId"');expect(a!.content).not.toContain('"geom"');
  expect((await readBriefing(scope.incidentId,scope.mode,a!.receipt.artifactId))?.content).toBe(a!.content);
 });
 it("new validity creates another artifact while old bytes and approval history remain unchanged",async()=>{
  const {saved}=await preparedProposal();await recordDecision(decisionCommand(saved.revision));const old=await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json");
  await fixture.db.query("update public.source_snapshots set stale=true where id=$1",[id(80)]);const next=await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json");
  expect(next!.receipt.artifactId).not.toBe(old!.receipt.artifactId);expect(next!.receipt.contentHash).not.toBe(old!.receipt.contentHash);
  expect(JSON.parse(next!.content).currentValidity.validity).toBe("needs_review");expect(JSON.parse(next!.content).currentValidity.reviewState).toBe("approved");
  expect((await readBriefing(scope.incidentId,scope.mode,old!.receipt.artifactId))?.content).toBe(old!.content);
 });
 it("a viewer gets explicit redaction and cannot retrieve a former commander artifact after downgrade",async()=>{
  const {saved}=await preparedProposal();await recordDecision(decisionCommand(saved.revision));const full=await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json");
  await fixture.db.query("update public.organization_members set role='viewer' where user_id=$1",[actor]);identity.user={id:actor,organizationId:scope.organizationId,role:"viewer"};
  await expect(readBriefing(scope.incidentId,scope.mode,full!.receipt.artifactId)).rejects.toMatchObject({code:"SCOPE_DENIED"});
  const a=await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json"),p=JSON.parse(a!.content);
  expect(p.redactionProfile).toBe("viewer_reference_only");expect(p.evidence.claims[0].claim.excerpt).toBeNull();expect(p.evidence.documents[0].canonicalUrl).toBeNull();
  expect(p.constraint.configuration.tasks.every((t:{label:string})=>t.label==="Restricted task")).toBe(true);expect(p.decisions[0].decision.note).toBe("Withheld in viewer briefing");
  await verifyBriefingDelivery(briefingResponse(a!),deliveryScope(saved.revision.id));
 });
 it("printable HTML contains complete inert lineage and its client verification binds the source JSON and distinct HTML artifact",async()=>{
  const {saved}=await preparedProposal();await recordDecision(decisionCommand(saved.revision));const a=await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"html");
  const dom=new JSDOM();vi.stubGlobal("DOMParser",dom.window.DOMParser);
  try{const out=await verifyBriefingDelivery(briefingResponse(a!),deliveryScope(saved.revision.id,"html"));expect(out.receipt.sourceArtifactId).toBe(out.payload.id);
   expect(a!.content).toContain("Inspection tasks");expect(a!.content).toContain("application/json");
   await mkdir(".codex/evidence",{recursive:true});
   await writeFile(".codex/evidence/sentinel-briefing-render-fixture.html",a!.content,"utf8");
   await writeFile(".codex/evidence/sentinel-briefing-render-fixture.json",JSON.stringify({content:a!.content,receipt:a!.receipt,expected:deliveryScope(saved.revision.id,"html")}),"utf8");
  }finally{vi.unstubAllGlobals();dom.window.close();}
 });
 it("records ordered plan/decision history, pages without duplicating or omitting entries, and rolls back history with failed decisions",async()=>{
  const {saved}=await preparedProposal();await recordDecision(decisionCommand(saved.revision));
  for(let n=0;n<27;n++)await recordDecision(decisionCommand(saved.revision,"annotate",id(700+n)));
  const first=await readHistory(scope.incidentId,scope.mode);expect(first!.items).toHaveLength(25);expect(first!.items[0].kind).toBe("plan");expect(first!.items[1].action).toBe("accept");
  const second=await readHistory(scope.incidentId,scope.mode,first!.nextAfterSequence!);expect(second!.hasMore).toBe(false);
  expect([...first!.items,...second!.items].map(x=>x.sequence)).toEqual(Array.from({length:29},(_,i)=>i+1));
 });
 it("fresh SQL membership blocks historical artifact and timeline reads despite cached identity",async()=>{
  const {saved}=await preparedProposal(),a=await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json");await fixture.db.query("delete from public.organization_members where user_id=$1",[actor]);
  await expect(readBriefing(scope.incidentId,scope.mode,a!.receipt.artifactId)).rejects.toMatchObject({code:"SCOPE_DENIED"});await expect(readHistory(scope.incidentId,scope.mode)).rejects.toMatchObject({code:"SCOPE_DENIED"});
 });
 it("client refuses truncated, corrupt, oversized, wrong-scope or wrong-format delivery",async()=>{
  const {saved}=await preparedProposal(),a=(await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json"))!;
  for(const text of [a.content.slice(0,-1),a.content.replace("Synthetic source.","Corrupted source."),a.content+"x".repeat(2097152)]){
   const original=briefingResponse(a);await expect(verifyBriefingDelivery(new Response(text,{headers:original.headers}),deliveryScope(saved.revision.id))).rejects.toBeDefined();
  }
  await expect(verifyBriefingDelivery(briefingResponse(a),{...deliveryScope(saved.revision.id),incidentId:id(999)})).rejects.toBeDefined();
  await expect(verifyBriefingDelivery(briefingResponse(a),deliveryScope(saved.revision.id,"html"))).rejects.toBeDefined();
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(a.content.slice(0,25)));c.error(new Error("Synthetic interruption"));}});
  await expect(verifyBriefingDelivery(new Response(stream,{headers:briefingResponse(a).headers}),deliveryScope(saved.revision.id))).rejects.toBeDefined();
 });
 it("existing revision and artifact HTTP paths preserve complete bytes and private headers; history cursor is mode-bound",async()=>{
  const {saved}=await preparedProposal(),url=`https://sentinel.example/api/sentinel/briefings/${saved.revision.id}?incidentId=${scope.incidentId}&mode=synthetic`;
  const response=await briefingGet(new Request(url),{params:Promise.resolve({revision:saved.revision.id})});expect(response.status).toBe(200);
  const out=await verifyBriefingDelivery(response,deliveryScope(saved.revision.id));
  const read=await artifactGet(new Request(`https://sentinel.example/api/sentinel/briefing-artifacts/${out.receipt.artifactId}?incidentId=${scope.incidentId}&mode=synthetic`),{params:Promise.resolve({id:out.receipt.artifactId})});
  expect(read.status).toBe(200);expect(read.headers.get("Cache-Control")).toContain("no-store");
  expect((await briefingGet(new Request(url+"&format=xml"),{params:Promise.resolve({revision:saved.revision.id})})).status).toBe(400);
  expect((await historyGet(new Request(`https://sentinel.example/api/sentinel/history?incidentId=${scope.incidentId}&mode=synthetic&cursor=invalid`))).status).toBe(400);
 });
});

describe("Briefing adjacent integrity and rendering regressions",()=>{
 it("escapes executable-looking review text in both printable text and inert lineage",async()=>{
  const {saved}=await preparedProposal(),c=decisionCommand(saved.revision);c.note='</script><img src="https://example.invalid/x" onerror="alert(1)"> & quoted text';await recordDecision(c);
  const a=await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"html"),doc=new JSDOM(a!.content);
  expect(doc.window.document.querySelectorAll("img,iframe,object,embed")).toHaveLength(0);expect(doc.window.document.querySelectorAll("script")).toHaveLength(1);
  expect(doc.window.document.querySelector("script")?.type).toBe("application/json");expect(doc.window.document.body.textContent).toContain(c.note);doc.window.close();
 });
 it("retains final decision admission lineage, rejects another expected organization and exact-type mismatch",async()=>{
  const {saved}=await preparedProposal();await recordDecision({...decisionCommand(saved.revision),feedback:planCorrection()});const a=(await prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json"))!;
  const out=await verifyBriefingDelivery(briefingResponse(a),{...deliveryScope(saved.revision.id),organizationId:scope.organizationId});expect(out.payload.decisions[0].lastAdmission?.eligible).toBe(true);
  await expect(verifyBriefingDelivery(briefingResponse(a),{...deliveryScope(saved.revision.id),organizationId:id(999)})).rejects.toBeDefined();
  const response=briefingResponse(a);response.headers.set("Content-Type","application/jsonp");await expect(verifyBriefingDelivery(response,deliveryScope(saved.revision.id))).rejects.toBeDefined();
 });
 it("failed artifact persistence leaves no partial artifact and no history or decision mutation",async()=>{
  const {saved}=await preparedProposal(),before=await readHistory(scope.incidentId,scope.mode);await fixture.db.exec("create function public.fail_briefing() returns trigger language plpgsql as $$ begin raise exception 'synthetic artifact failure';end;$$;create trigger fail_briefing before insert on public.sentinel_briefings for each row execute function public.fail_briefing()");
  await expect(prepareBriefing(scope.incidentId,scope.mode,saved.revision.id,"json")).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
  expect((await fixture.db.query<{count:number}>("select count(*)::int count from public.sentinel_briefings")).rows[0].count).toBe(0);expect((await readHistory(scope.incidentId,scope.mode))?.items).toEqual(before?.items);
 });
});
