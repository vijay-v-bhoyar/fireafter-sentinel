import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyCommandSchema } from "./policy-contracts";
import { recordPolicy, readPolicy, previewPlanAdmission } from "./policies";
const fixture=vi.hoisted(()=>({user:null as unknown,rpc:vi.fn()}));
vi.mock("../auth",()=>({getCurrentUser:async()=>fixture.user}));
vi.mock("../supabase",()=>({getSupabaseAdminClient:()=>({rpc:fixture.rpc})}));
const id=(n:number)=>`d1000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope={organizationId:id(1),incidentId:id(2),mode:"synthetic" as const},user={id:id(3),organizationId:id(1),role:"incident_commander"};
const at="2026-10-11T08:00:00.000Z";
const config=()=>({schemaVersion:1,inputBasis:"demo",evaluationAt:at,note:"Synthetic policy.",documentRules:[{documentId:id(4),maxAgeMinutes:30,requirePublicationTime:true,requireEffectiveInterval:true}],
 nativeRules:[{sourceKey:"nws-forecast",maxAgeMinutes:30,requireProviderTime:true,requireValidUntil:true}]});
const command=()=>({incidentId:scope.incidentId,mode:scope.mode,commandId:id(5),expectedPolicyRevision:null,expectedSourceConfiguration:id(6),expectedEvidenceGeneration:3,configuration:config()});
function result(){return {replayed:false,revision:{id:id(7),scope,sourceConfigurationId:id(6),configuration:config(),policyHash:"a".repeat(64),createdBy:user.id,createdAt:at},
 receipt:{scope,commandId:id(5),actorId:user.id,revisionId:id(7),previousRevisionId:null,sourceConfigurationId:id(6),changed:true,committedAt:at,evidenceGeneration:4,unresolvedSourceChanges:0}};}
const input={incidentId:scope.incidentId,mode:scope.mode,planRevisionId:id(8)};
function admission(){return {scope,planRevisionId:id(8),policyRevisionId:id(7),currentPlanRevisionId:id(8),evidenceGeneration:4,evidenceVectorHash:"b".repeat(64),checkedAt:at,timeBasis:"scenario",
 eligible:true,approvalReady:false,blockers:[] as string[],documentChecks:[{documentId:id(4),versionId:id(9),issues:[] as string[]}],nativeChecks:[{sourceKey:"nws-forecast",snapshotId:id(10),issues:[] as string[]}]};}
beforeEach(()=>{fixture.user=user;fixture.rpc.mockReset();});
describe("Explicit policy input and untrusted response boundary",()=>{
 it("requires scenario time outside live mode and a database clock in live mode",()=>{
  expect(PolicyCommandSchema.safeParse({...command(),mode:"live"}).success).toBe(false);
  expect(PolicyCommandSchema.safeParse({...command(),configuration:{...config(),evaluationAt:null}}).success).toBe(false);
  expect(PolicyCommandSchema.safeParse({...command(),mode:"live",configuration:{...config(),inputBasis:"user_authored",evaluationAt:null}}).success).toBe(true);
 });
 for(const bad of [{...command(),actorId:id(99)},{...command(),configuration:{...config(),note:"\0"}},{...command(),configuration:{...config(),note:"x".repeat(2049)}},
  {...command(),configuration:{...config(),nativeRules:[{...config().nativeRules[0],requireValidUntil:false}]}},
  {...command(),configuration:{...config(),documentRules:[config().documentRules[0],config().documentRules[0]]}}]){
  it("rejects authority injection, invalid text and weakened/duplicate rules before storage",async()=>{
   await expect(recordPolicy(bad)).rejects.toMatchObject({code:"INPUT_INVALID"});expect(fixture.rpc).not.toHaveBeenCalled();
  });
 }
 it("binds the immutable policy and receipt to the authenticated command",async()=>{
  fixture.rpc.mockResolvedValue({data:result(),error:null});expect((await recordPolicy(command())).receipt.changed).toBe(true);
  expect(fixture.rpc.mock.calls[0][1].p_actor_id).toBe(user.id);
 });
 for(const field of ["actorId","revisionId","sourceConfigurationId","committedAt"] as const){it(`rejects a misbound ${field}`,async()=>{
  const out=result();out.receipt[field]=field==="committedAt"?"2026-10-11T09:00:00.000Z":id(99);fixture.rpc.mockResolvedValue({data:out,error:null});
  await expect(recordPolicy(command())).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
 });}
 for(const change of ["approval","emptyChecks","contradiction","wrongRevision","wrongClock"]){it(`rejects malformed admission ${change}`,async()=>{
  const out=admission();if(change==="approval")out.approvalReady=true;
  if(change==="emptyChecks")out.documentChecks=[];if(change==="contradiction")out.blockers=["source_reviews_pending"];
  if(change==="wrongRevision")out.planRevisionId=id(99);if(change==="wrongClock")out.timeBasis="database";
  fixture.rpc.mockResolvedValue({data:out,error:null});await expect(previewPlanAdmission(input)).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
 });}
 it("allows a viewer to read but never author policy",async()=>{
  fixture.user={...user,role:"viewer"};fixture.rpc.mockResolvedValue({data:null,error:null});expect(await readPolicy(scope.incidentId,scope.mode)).toBeNull();
  fixture.rpc.mockClear();await expect(recordPolicy(command())).rejects.toMatchObject({code:"SCOPE_DENIED"});expect(fixture.rpc).not.toHaveBeenCalled();
 });
 it("does not return an oversized private response",async()=>{
  fixture.rpc.mockResolvedValue({data:{...admission(),extra:"x".repeat(1_048_576)},error:null});
  await expect(previewPlanAdmission(input)).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
 });
});
