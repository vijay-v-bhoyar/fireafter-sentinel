import { z } from "zod";
import { ScopeSchema, IdSchema, ModeSchema, RoleSchema, SENTINEL_LIMITS } from "./contracts";
import { DecisionSchema, DecisionReceiptSchema, FinalDecisionValidationSchema } from "./decision-contracts";
import { FeedbackObservationSchema } from "./feedback-contracts";
import type { readEvidenceSummary } from "./sources";
import type { readChangePage } from "./changes";
import type { readPlanDraft } from "./plans";
import type { readConstraints } from "./constraints";
import type { readPolicy, previewPlanAdmission } from "./policies";
import type { readMarkerReview } from "./marker-reviews";
import type { readClaimPage } from "./claims";
import type { readClaimReview } from "./claim-reviews";
import type { readHistory } from "./briefings";
export type WorkspaceIdentity={id:string;organizationId:string;role:z.infer<typeof RoleSchema>};
export type EvidenceSummary=NonNullable<Awaited<ReturnType<typeof readEvidenceSummary>>>;
export type ChangesPage=NonNullable<Awaited<ReturnType<typeof readChangePage>>> & {nextCursor:string|null};
export type PlanPage=NonNullable<Awaited<ReturnType<typeof readPlanDraft>>>;
export type ConstraintsPage=NonNullable<Awaited<ReturnType<typeof readConstraints>>>;
export type PolicyPage=NonNullable<Awaited<ReturnType<typeof readPolicy>>>;
export type Admission=NonNullable<Awaited<ReturnType<typeof previewPlanAdmission>>>;
export type MarkerPage=NonNullable<Awaited<ReturnType<typeof readMarkerReview>>>;
export type ClaimsPage=NonNullable<Awaited<ReturnType<typeof readClaimPage>>> & {nextCursor:string|null};
export type ClaimReviewPage=NonNullable<Awaited<ReturnType<typeof readClaimReview>>>;
export type HistoryPage=Omit<NonNullable<Awaited<ReturnType<typeof readHistory>>>,'nextAfterSequence'> & {nextCursor:string|null};
export class WorkspaceRequestError extends Error{constructor(readonly status:number,readonly code:string,message:string){super(message);}}
export function workspaceScope(identity:WorkspaceIdentity,incidentId:string,mode:string){return ScopeSchema.parse({organizationId:identity.organizationId,incidentId,mode});}
export function scopeQuery(incidentId:string,mode:string){return new URLSearchParams({incidentId:IdSchema.parse(incidentId).toLowerCase(),mode:ModeSchema.parse(mode)}).toString();}
/** A bounded same-origin API read. Server helpers own full record validation; the client rejects another scope before rendering or using fences. */
export async function workspaceRequest<T>(url:string,scope:z.infer<typeof ScopeSchema>,options:{body?:unknown;signal?:AbortSignal;scoped?:boolean;maxBytes?:number}={}){
 if(!url.startsWith('/api/')||url.startsWith('//'))throw new WorkspaceRequestError(400,'INPUT_INVALID','Only this application\'s API can be requested.');
 const response=await fetch(url,{method:options.body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',signal:options.signal,
  ...(options.body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(options.body)})});
 const reader=response.body?.getReader();if(!reader)throw new WorkspaceRequestError(503,'DELIVERY_INCOMPLETE','The response could not be read.');
 const parts:Uint8Array[]=[];let length=0;
 try{while(true){const step=await reader.read();if(step.done)break;length+=step.value.byteLength;if(length>(options.maxBytes??SENTINEL_LIMITS.providerResponseBytes)){await reader.cancel();throw new Error('capacity');}parts.push(step.value);}}
 catch{throw new WorkspaceRequestError(503,'DELIVERY_INCOMPLETE','The complete response was unavailable. Refresh or reconcile the original command.');}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let position=0;for(const p of parts){bytes.set(p,position);position+=p.byteLength;}
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new WorkspaceRequestError(503,'DELIVERY_INCOMPLETE','The response could not be validated.');}
 if(!response.ok){const safe=z.object({error:z.string().max(1000),code:z.string().max(80).optional()}).safeParse(value);throw new WorkspaceRequestError(response.status,safe.success?safe.data.code??'REQUEST_FAILED':'REQUEST_FAILED',safe.success?safe.data.error:'This request could not be completed.');}
 if(options.scoped!==false){const got=z.object({scope:ScopeSchema}).safeParse(value);if(!got.success||JSON.stringify(got.data.scope)!==JSON.stringify(scope))throw new WorkspaceRequestError(503,'SCOPE_MISMATCH','The response belongs to a different workspace. Reload before continuing.');}
 return value as T;
}
export const DecisionResultSchema=z.strictObject({decision:DecisionSchema,receipt:DecisionReceiptSchema,replayed:z.boolean(),finalValidation:FinalDecisionValidationSchema.nullable(),feedback:FeedbackObservationSchema.optional()});
export function confirmedDecision(value:unknown,scope:z.infer<typeof ScopeSchema>,actorId:string,commandId:string,revisionId:string){
 const r=DecisionResultSchema.parse(value);if(JSON.stringify(r.decision.scope)!==JSON.stringify(scope)||JSON.stringify(r.receipt.scope)!==JSON.stringify(scope)||r.receipt.commandId!==commandId||
  r.receipt.actorId!==actorId||r.decision.actorId!==actorId||r.receipt.decisionId!==r.decision.id||r.receipt.id!==r.decision.receiptId||r.decision.planRevisionId!==revisionId||r.receipt.reviewedPlanRevision!==revisionId||
  r.receipt.auditId!==r.decision.auditId||r.receipt.action!==r.decision.action||r.receipt.newPlanRevisionId!==r.decision.newPlanRevisionId||r.receipt.reviewedEvidenceGeneration!==r.decision.reviewedEvidenceGeneration||
  r.receipt.reviewedEvidenceVectorHash!==r.decision.reviewedEvidenceVectorHash||r.receipt.checkedAt!==r.decision.checkedAt||r.receipt.committedAt!==r.decision.committedAt||
  (r.decision.action==='accept')!==(r.finalValidation!==null)||r.finalValidation&&(r.finalValidation.decisionId!==r.decision.id||r.finalValidation.planRevisionId!==revisionId||r.finalValidation.evidenceVectorHash!==r.decision.reviewedEvidenceVectorHash))
  throw new WorkspaceRequestError(503,'RECEIPT_MISMATCH','The decision receipt could not be confirmed. Check its original command status.');return r;
}
