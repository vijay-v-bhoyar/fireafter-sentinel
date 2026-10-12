import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordDecision, readDecisionCommand } from "./decisions";
import { DecisionCommandSchema } from "./decision-contracts";
const fixture=vi.hoisted(()=>({user:null as unknown,rpc:vi.fn()}));
vi.mock("../auth",()=>({getCurrentUser:async()=>fixture.user}));
vi.mock("../supabase",()=>({getSupabaseAdminClient:()=>({rpc:fixture.rpc})}));
const id=(n:number)=>`f1000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const scope={organizationId:id(1),incidentId:id(2),mode:"synthetic" as const},user={id:id(3),organizationId:id(1),role:"incident_commander"};
const at="2026-10-11T08:00:00.000Z";
function command(){return {incidentId:scope.incidentId,mode:scope.mode,planRevisionId:id(4),expectedPlanRevision:id(4),commandId:id(5),expectedEvidenceGeneration:3,
 expectedEvidenceVectorHash:"a".repeat(64),expectedConstraintRevision:id(6),expectedPolicyRevision:id(7),action:"accept",note:"Synthetic decision.",modifications:null};}
function result(){return {replayed:false,decision:{id:id(8),scope,receiptId:id(9),auditId:id(10),planId:id(11),planRevisionId:id(4),newPlanRevisionId:null,actorId:user.id,action:"accept",note:"Synthetic decision.",
 reviewedEvidenceGeneration:3,reviewedEvidenceVectorHash:"a".repeat(64),constraintRevisionId:id(6),policyRevisionId:id(7),checkedAt:at,committedAt:at,timeBasis:"scenario"},
 receipt:{id:id(9),scope,commandId:id(5),actorId:user.id,decisionId:id(8),auditId:id(10),reviewedPlanRevision:id(4),newPlanRevisionId:null,reviewedEvidenceGeneration:3,reviewedEvidenceVectorHash:"a".repeat(64),action:"accept",checkedAt:at,committedAt:at},
 finalValidation:{kind:"final_admission",decisionId:id(8),planRevisionId:id(4),checkedAt:at,timeBasis:"scenario",evidenceVectorHash:"a".repeat(64),eligible:true}};}
beforeEach(()=>{fixture.user=user;fixture.rpc.mockReset();});
describe("Decision receipt/authority boundary and immutable command intent",()=>{
 it("binds the response and final admission to the original authenticated command",async()=>{
  fixture.rpc.mockResolvedValue({data:result(),error:null});const out=await recordDecision(command());expect(out.decision.id).toBe(id(8));expect(out.finalValidation?.eligible).toBe(true);
  expect(fixture.rpc.mock.calls[0][1].p_actor_id).toBe(user.id);expect(fixture.rpc.mock.calls[0][1].p_command).not.toHaveProperty("organizationId");
 });
 for(const field of ["actorId","decisionId","auditId","reviewedPlanRevision","reviewedEvidenceVectorHash","committedAt"] as const){it(`rejects misbound ${field} receipt`,async()=>{
  const out=result();out.receipt[field]=field==="reviewedEvidenceVectorHash"?"b".repeat(64):field==="committedAt"?"2026-10-11T09:00:00.000Z":id(99);
  fixture.rpc.mockResolvedValue({data:out,error:null});await expect(recordDecision(command())).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
 });}
 for(const change of ["missingFinal","wrongFinal","earlierFinal","wrongClock","wrongNote","wrongScope"]){it(`rejects altered ${change}`,async()=>{
  const out=result();if(change==="missingFinal")Object.assign(out,{finalValidation:null});if(change==="wrongFinal")out.finalValidation.decisionId=id(99);
  if(change==="earlierFinal")out.finalValidation.checkedAt="2026-10-11T07:59:59.000Z";if(change==="wrongClock"){out.decision.timeBasis="database";out.finalValidation.timeBasis="database";}
  if(change==="wrongNote")out.decision.note="Unreviewed substituted note.";if(change==="wrongScope")out.decision.scope={...scope,incidentId:id(99)};
  fixture.rpc.mockResolvedValue({data:out,error:null});await expect(recordDecision(command())).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
 });}
 for(const role of ["viewer","analyst"]){it(`prevents ${role} from accepting without a storage call`,async()=>{
  fixture.user={...user,role};await expect(recordDecision(command())).rejects.toMatchObject({code:"SCOPE_DENIED"});expect(fixture.rpc).not.toHaveBeenCalled();
 });}
 for(const bad of [{...command(),actorId:id(99)},{...command(),feedback:{}},{...command(),note:"\0"},{...command(),note:"x".repeat(2049)},
  {...command(),expectedPlanRevision:id(99)},{...command(),action:"modify"},{...command(),modifications:{assignments:[]}}]){
  it("rejects authority, unsupported feedback, malformed notes and modifications before storage",async()=>{
   await expect(recordDecision(bad)).rejects.toMatchObject({code:"INPUT_INVALID"});expect(fixture.rpc).not.toHaveBeenCalled();
  });
 }
 it("requires unique bounded manual assignments on modify only",()=>{
  const a={taskId:id(20),crewId:id(21),startsAt:at};expect(DecisionCommandSchema.safeParse({...command(),action:"modify",modifications:{assignments:[a]}}).success).toBe(true);
  expect(DecisionCommandSchema.safeParse({...command(),action:"modify",modifications:{assignments:[a,a]}}).success).toBe(false);
 });
 it("handles absent receipt as not observed without manufacturing success",async()=>{
  fixture.rpc.mockResolvedValue({data:null,error:null});expect(await readDecisionCommand(scope.incidentId,scope.mode,id(5))).toBeNull();
 });
 it("binds a reconciled receipt to the caller's original command and scope",async()=>{
  fixture.rpc.mockResolvedValue({data:{...result(),replayed:true},error:null});expect((await readDecisionCommand(scope.incidentId,scope.mode,id(5)))?.replayed).toBe(true);
  await expect(readDecisionCommand(scope.incidentId,scope.mode,id(99))).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
 });
 it("redacts unexpected storage errors and maps deadlock aborts to explicit conflicts",async()=>{
  fixture.rpc.mockResolvedValue({data:null,error:{code:"40P01",message:"private diagnostics"}});await expect(recordDecision(command())).rejects.toMatchObject({code:"DECISION_CONFLICT"});
  fixture.rpc.mockResolvedValue({data:null,error:{code:"XX000",message:"secret-bearing upstream diagnostic"}});await expect(recordDecision(command())).rejects.toMatchObject({message:"Decision storage is unavailable. Reconcile the original command before retrying."});
 });
});

function feedbackInput(){return {schemaVersion:1 as const,claimId:id(20),originalClaimHash:"b".repeat(64),correctedClaimText:"Synthetic correction.",correctedClaimId:null,reasonCode:"other" as const,permissionRecordId:null};}
function signal(){return {id:id(21),scope,claimId:id(20),documentVersionId:id(22),runId:id(23),modelVersion:"synthetic",promptVersion:"synthetic",policyRevisionId:id(7),
 originalClaimHash:"b".repeat(64),correctedClaimText:"Synthetic correction.",correctedClaimId:null,reasonCode:"other",reviewKind:"plan",claimReviewId:null,reviewDecisionId:id(8),receiptId:id(9),actorId:user.id,createdAt:at,permissionRecordId:null};}
describe("Feedback response integrity at the decision service boundary",()=>{
 it("accepts only a signal bound to the exact requested correction and receipt",async()=>{
  fixture.rpc.mockResolvedValue({data:{...result(),feedback:signal()},error:null});expect((await recordDecision({...command(),feedback:feedbackInput()})).feedback?.id).toBe(id(21));
 });
 for(const field of ["receiptId","actorId","reviewDecisionId","policyRevisionId","originalClaimHash","correctedClaimText","permissionRecordId"] as const){
  it(`rejects an untrusted signal with altered ${field}`,async()=>{
   const f=signal();Object.assign(f,{[field]:field==="originalClaimHash"?"c".repeat(64):field==="correctedClaimText"?"Altered correction":id(99)});
   fixture.rpc.mockResolvedValue({data:{...result(),feedback:f},error:null});await expect(recordDecision({...command(),feedback:feedbackInput()})).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
  });
 }
 it("does not accept a missing requested signal or an unsolicited signal",async()=>{
  fixture.rpc.mockResolvedValue({data:result(),error:null});await expect(recordDecision({...command(),feedback:feedbackInput()})).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
  fixture.rpc.mockResolvedValue({data:{...result(),feedback:signal()},error:null});await expect(recordDecision(command())).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
 });
});
