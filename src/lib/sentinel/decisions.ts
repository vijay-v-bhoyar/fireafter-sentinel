import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { assertEvidenceScope } from "./evidence";
import { IdSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS, utf8Bytes } from "./contracts";
import { DecisionCommandSchema, DecisionSchema, DecisionReceiptSchema as receiptSchema, FinalDecisionValidationSchema as finalSchema, type DecisionCommand } from "./decision-contracts";
import { FeedbackObservationSchema, feedbackMatches } from "./feedback-contracts";
export { DecisionSchema } from "./decision-contracts";
const id=IdSchema.transform(v=>v.toLowerCase());
const resultSchema=z.strictObject({decision:DecisionSchema,receipt:receiptSchema,replayed:z.boolean(),finalValidation:finalSchema.nullable(),feedback:FeedbackObservationSchema.optional()});
const messages={AUTH_REQUIRED:"Sign in to record a decision.",SCOPE_DENIED:"This decision is unavailable in your workspace.",INPUT_INVALID:"Decision input is invalid or exceeds the supported bounds.",
 DECISION_CONFLICT:"The proposal or evidence changed, or this proposal is already decided. Refresh before continuing.",STORAGE_UNAVAILABLE:"Decision storage is unavailable. Reconcile the original command before retrying."};
export class SentinelDecisionError extends Error{constructor(readonly code:keyof typeof messages){super(messages[code]);this.name="SentinelDecisionError";}}
async function actor(writeAction?:DecisionCommand["action"]){
 const u=await getCurrentUser();if(!u)throw new SentinelDecisionError("AUTH_REQUIRED");
 const roles=writeAction?["accept","reject"].includes(writeAction)?["incident_commander"]:["incident_commander","analyst"]:["incident_commander","analyst","viewer"];
 if(!u.organizationId||!u.role||!roles.includes(u.role))throw new SentinelDecisionError("SCOPE_DENIED");return {id:id.parse(u.id),organizationId:id.parse(u.organizationId)};
}
async function rpc(name:string,params:Record<string,unknown>){
 const db=getSupabaseAdminClient() as SupabaseClient|null;if(!db)throw new SentinelDecisionError("STORAGE_UNAVAILABLE");const {data,error}=await db.rpc(name,params);
 if(error)throw new SentinelDecisionError(error.code==="42501"?"SCOPE_DENIED":error.code==="22023"?"INPUT_INVALID":["40001","23505","40P01"].includes(error.code)?"DECISION_CONFLICT":"STORAGE_UNAVAILABLE");
 if(data!==null&&utf8Bytes(JSON.stringify(data))>SENTINEL_LIMITS.providerResponseBytes)throw new SentinelDecisionError("STORAGE_UNAVAILABLE");return data;
}
function bind(result:z.infer<typeof resultSchema>,scope:z.infer<typeof ScopeSchema>,actorId:string,commandId:string){
 const d=result.decision,r=result.receipt,f=result.finalValidation;assertEvidenceScope(d.scope,scope);assertEvidenceScope(r.scope,scope);
 if(d.actorId!==actorId||r.actorId!==actorId||r.commandId!==commandId||r.decisionId!==d.id||r.id!==d.receiptId||r.auditId!==d.auditId||r.reviewedPlanRevision!==d.planRevisionId||r.newPlanRevisionId!==d.newPlanRevisionId||
  r.action!==d.action||r.checkedAt!==d.checkedAt||r.committedAt!==d.committedAt||r.reviewedEvidenceGeneration!==d.reviewedEvidenceGeneration||r.reviewedEvidenceVectorHash!==d.reviewedEvidenceVectorHash||
  (d.action==="modify")!==(d.newPlanRevisionId!==null)|| (d.action==="accept")!==(f!==null) ||
  (f&&(f.decisionId!==d.id||f.planRevisionId!==d.planRevisionId||f.evidenceVectorHash!==d.reviewedEvidenceVectorHash||f.timeBasis!==d.timeBasis||Date.parse(f.checkedAt)<Date.parse(d.checkedAt))))throw new SentinelDecisionError("STORAGE_UNAVAILABLE");
 if(!feedbackMatches(result.feedback,{scope,actorId,receiptId:r.id,reviewId:d.id,kind:"plan"}) ||
  (result.feedback && result.feedback.policyRevisionId!==d.policyRevisionId))throw new SentinelDecisionError("STORAGE_UNAVAILABLE");
 return result;
}
export async function recordDecision(input:unknown){
 const parsed=DecisionCommandSchema.safeParse(input);if(!parsed.success||utf8Bytes(JSON.stringify(parsed.data))>SENTINEL_LIMITS.mutationBytes)throw new SentinelDecisionError("INPUT_INVALID");
 try{const c=parsed.data,u=await actor(c.action),scope={organizationId:u.organizationId,incidentId:c.incidentId,mode:c.mode};
  const {incidentId:unusedIncident,mode:unusedMode,planRevisionId:unusedRevision,...command}=c;void unusedIncident;void unusedMode;void unusedRevision;
  const result=bind(resultSchema.parse(await rpc("sentinel_record_decision",{p_actor_id:u.id,p_organization_id:u.organizationId,p_incident_id:c.incidentId,p_mode:c.mode,p_revision_id:c.planRevisionId,p_command:command})),scope,u.id,c.commandId);
  const d=result.decision;
  if(Boolean(c.feedback)!==Boolean(result.feedback)||!feedbackMatches(result.feedback,{scope,actorId:u.id,receiptId:result.receipt.id,reviewId:d.id,kind:"plan",input:c.feedback}))throw new SentinelDecisionError("STORAGE_UNAVAILABLE");
  if(d.planRevisionId!==c.planRevisionId||d.action!==c.action||d.note!==c.note||d.reviewedEvidenceGeneration!==c.expectedEvidenceGeneration||d.reviewedEvidenceVectorHash!==c.expectedEvidenceVectorHash||
   d.constraintRevisionId!==c.expectedConstraintRevision||d.policyRevisionId!==c.expectedPolicyRevision|| (d.action==="accept"&&d.timeBasis!==(c.mode==="live"?"database":"scenario")))throw new SentinelDecisionError("STORAGE_UNAVAILABLE");
  return result;
 }catch(error){if(error instanceof SentinelDecisionError)throw error;throw new SentinelDecisionError("STORAGE_UNAVAILABLE");}
}
export async function readDecisionCommand(incidentId:string,mode:string,commandId:string){
 const parsed=z.strictObject({incidentId:id,mode:ModeSchema,commandId:id}).safeParse({incidentId,mode,commandId});if(!parsed.success)throw new SentinelDecisionError("INPUT_INVALID");
 try{const c=parsed.data,u=await actor(),scope={organizationId:u.organizationId,incidentId:c.incidentId,mode:c.mode};
  const data=await rpc("sentinel_read_decision_command",{p_actor_id:u.id,p_organization_id:u.organizationId,p_incident_id:c.incidentId,p_mode:c.mode,p_command_id:c.commandId});
  return data===null?null:bind(resultSchema.parse(data),scope,u.id,c.commandId);
 }catch(error){if(error instanceof SentinelDecisionError)throw error;throw new SentinelDecisionError("STORAGE_UNAVAILABLE");}
}
