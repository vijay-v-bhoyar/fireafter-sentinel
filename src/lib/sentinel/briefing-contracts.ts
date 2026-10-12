import { z } from "zod";
import { ClaimSchema, ClaimReviewSchema, HashSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, RegisteredUrlSchema, AvailabilitySchema, ContentPermissionSchema } from "./contracts";
import { PlanRevisionSchema, TaskDependenciesSchema } from "./plan-contracts";
import { ConstraintConfigurationSchema } from "./planning";
import { DecisionSchema, DecisionReceiptSchema, FinalDecisionValidationSchema } from "./decision-contracts";
const count=z.number().int().nonnegative().safe();
const referenceTime=z.string().max(64).refine(v=>/^\d{4}-\d\d-\d\dT.*(?:Z|\+00:00)$/.test(v)&&Number.isFinite(Date.parse(v)));
export const BriefingProfileSchema=z.enum(["member_full","viewer_reference_only"]);
export const BriefingReceiptSchema=z.strictObject({id:IdSchema,artifactId:IdSchema,sourceArtifactId:IdSchema.nullable(),scope:ScopeSchema,
 planRevisionId:IdSchema,issuedBy:IdSchema,createdAt:InstantSchema,redactionProfile:BriefingProfileSchema,format:z.enum(["json","html"]),
 contentHash:HashSchema,contentBytes:count.min(1).max(2097152),status:z.literal("artifact_created")})
 .refine(v=>(v.format==="json")===(v.sourceArtifactId===null));
const claim=z.strictObject({...ClaimSchema.shape,claimText:z.string().max(2000).nullable(),excerpt:z.string().max(102400).nullable()});
const claimReceipt=z.strictObject({id:IdSchema,commandId:IdSchema,claimId:IdSchema,reviewId:IdSchema,previousReviewId:IdSchema.nullable(),scope:ScopeSchema,
 actorId:IdSchema,committedAt:InstantSchema,evidenceGeneration:count,unresolvedSourceChanges:count});
export const BriefingPayloadSchema=z.strictObject({schemaVersion:z.literal(1),id:IdSchema,receiptId:IdSchema,scope:ScopeSchema,createdAt:InstantSchema,redactionProfile:BriefingProfileSchema,
 plan:PlanRevisionSchema,constraint:z.strictObject({id:IdSchema,constraintHash:HashSchema,configuration:ConstraintConfigurationSchema,configurationRedacted:z.boolean()}),
 policy:z.strictObject({id:IdSchema,policyHash:HashSchema,sourceConfigurationId:IdSchema,configuration:z.record(z.string(),z.unknown()),configurationRedacted:z.boolean()}).nullable(),
 evidence:z.strictObject({originalSnapshotHash:HashSchema,sourceConfigurationId:IdSchema.nullable(),sourceConfigurationHash:HashSchema.nullable(),
  documents:z.array(z.strictObject({documentId:IdSchema,versionId:IdSchema,configurationId:IdSchema,identityHash:HashSchema,normalizedHash:HashSchema,rawHash:HashSchema,
   availability:AvailabilitySchema,contentPermission:ContentPermissionSchema,canonicalUrl:RegisteredUrlSchema.nullable(),issuer:z.string().max(200).nullable(),jurisdiction:z.string().max(200).nullable(),
   publishedAt:referenceTime.nullable(),effectiveFrom:referenceTime.nullable(),effectiveUntil:referenceTime.nullable(),retrievedAt:referenceTime,capturedHead:z.boolean()})).max(30),
  claims:z.array(z.strictObject({claim,claimTextHash:HashSchema,review:ClaimReviewSchema.nullable(),reviewReceipt:claimReceipt.nullable()})).max(25),
  assetReferences:z.array(z.strictObject({taskId:IdSchema,assetId:IdSchema,assetHash:HashSchema})).max(10),
  nativeReferences:z.array(z.strictObject({id:IdSchema,sourceName:z.string().max(200).nullable(),fetchedAt:referenceTime,sourceUpdatedAt:referenceTime.nullable(),status:z.string().max(100),stale:z.boolean(),payloadHash:HashSchema,snapshotHash:HashSchema})),
  retrievalChecks:z.array(z.strictObject({document_id:IdSchema,id:IdSchema,checked_version_id:IdSchema.nullable(),source_config_revision:IdSchema,
   requested_at:referenceTime,completed_at:referenceTime,outcome:z.enum(["version","same_version","incomplete","failed","withdrawn"]),event_sequence:count})).max(5),taskDependencies:TaskDependenciesSchema}),
 decisions:z.array(z.strictObject({decision:DecisionSchema,receipt:DecisionReceiptSchema,lastAdmission:FinalDecisionValidationSchema.nullable()})),
 currentValidity:z.strictObject({isCurrentRevision:z.boolean(),snapshotMatchesCurrent:z.boolean(),validity:z.enum(["current","needs_review","unavailable"]),approvalReady:z.boolean(),
  reviewState:z.enum(["draft","approved","rejected","superseded"]),isCurrentApprovedPlan:z.boolean(),terminalDecision:z.strictObject({decisionId:IdSchema,action:z.enum(["accept","reject"]),actorId:IdSchema,checkedAt:InstantSchema,committedAt:InstantSchema}).nullable(),observedAt:InstantSchema}),
 limitations:z.array(z.string().min(1).max(1000)).min(1).max(10),
}).superRefine((v,ctx)=>{
 const same=(s:z.infer<typeof ScopeSchema>)=>s.organizationId===v.scope.organizationId&&s.incidentId===v.scope.incidentId&&s.mode===v.scope.mode;
 const bad=()=>ctx.addIssue({code:"custom",message:"Briefing lineage, completeness or redaction is inconsistent."});
 if(!same(v.plan.scope)||v.constraint.id!==v.plan.constraintRevisionId||v.evidence.originalSnapshotHash!==v.plan.evidenceVectorHash||v.policy?.id!== (v.plan.policyRevisionId??undefined)||
  JSON.stringify(v.evidence.taskDependencies)!==JSON.stringify(v.plan.taskDependencies))bad();
 const tasks=v.constraint.configuration.tasks,taskIds=new Set(tasks.map(t=>t.id)),assetMap=new Map(v.evidence.assetReferences.map(x=>[x.taskId,x.assetId]));
 if(v.plan.allocation.selectedTaskIds.length!==taskIds.size||v.plan.allocation.selectedTaskIds.some(id=>!taskIds.has(id))||v.plan.taskDependencies.length!==taskIds.size||v.plan.taskDependencies.some(d=>!taskIds.has(d.taskId))||assetMap.size!==tasks.length||tasks.some(t=>assetMap.get(t.id)!==t.assetId))bad();
 const versions=new Set(v.evidence.documents.map(d=>d.versionId)),claims=new Map(v.evidence.claims.map(x=>[x.claim.id,x]));
 if(versions.size!==v.evidence.documents.length||claims.size!==v.evidence.claims.length||v.plan.taskDependencies.some(d=>d.claimIds.some(id=>!claims.has(id))))bad();
 for(const x of v.evidence.claims){
  if(!same(x.claim.scope)||!versions.has(x.claim.documentVersionId)||(x.review===null)!==(x.reviewReceipt===null))bad();
  if(x.review&&x.reviewReceipt&&(!same(x.review.scope)||!same(x.reviewReceipt.scope)||x.review.claimId!==x.claim.id||x.reviewReceipt.claimId!==x.claim.id||
   x.review.receiptId!==x.reviewReceipt.id||x.review.id!==x.reviewReceipt.reviewId||x.review.actorId!==x.reviewReceipt.actorId||x.review.createdAt!==x.reviewReceipt.committedAt))bad();
 }
 for(const x of v.decisions){if(!same(x.decision.scope)||!same(x.receipt.scope)||x.decision.planRevisionId!==v.plan.id||x.receipt.reviewedPlanRevision!==v.plan.id||x.decision.receiptId!==x.receipt.id||
  x.decision.id!==x.receipt.decisionId||x.decision.actorId!==x.receipt.actorId||x.decision.action!==x.receipt.action||x.decision.committedAt!==x.receipt.committedAt||x.decision.auditId!==x.receipt.auditId||x.decision.constraintRevisionId!==v.plan.constraintRevisionId||x.decision.policyRevisionId!==v.plan.policyRevisionId||
  x.decision.reviewedEvidenceGeneration!==v.plan.evidenceGeneration||x.decision.reviewedEvidenceVectorHash!==v.plan.evidenceVectorHash||x.receipt.reviewedEvidenceGeneration!==x.decision.reviewedEvidenceGeneration||
  x.receipt.reviewedEvidenceVectorHash!==x.decision.reviewedEvidenceVectorHash||(x.decision.action==="accept")!==(x.lastAdmission!==null)||x.lastAdmission&&
  (x.lastAdmission.decisionId!==x.decision.id||x.lastAdmission.planRevisionId!==v.plan.id||x.lastAdmission.evidenceVectorHash!==v.plan.evidenceVectorHash))bad();}
 if(v.redactionProfile==="viewer_reference_only"&&(v.evidence.claims.some(x=>x.claim.claimText!==null||x.claim.excerpt!==null||!!x.review&&x.review.note!=="Withheld in viewer briefing")||
  v.evidence.documents.some(d=>d.canonicalUrl!==null||d.issuer!==null||d.jurisdiction!==null)||v.evidence.nativeReferences.some(n=>n.sourceName!==null)||
  tasks.some(t=>t.label!=="Restricted task")||v.constraint.configuration.crews.some(c=>c.label!=="Restricted crew")||!v.constraint.configurationRedacted||
  v.decisions.some(d=>d.decision.note!=="Withheld in viewer briefing")))bad();
 if(v.redactionProfile==="member_full"&&(v.constraint.configurationRedacted||v.evidence.claims.some(x=>x.claim.claimText===null||x.claim.excerpt===null)))bad();
});
export type BriefingPayload=z.infer<typeof BriefingPayloadSchema>;
export type BriefingReceipt=z.infer<typeof BriefingReceiptSchema>;
export const HistoryPageSchema=z.strictObject({scope:ScopeSchema,items:z.array(z.strictObject({sequence:count.min(1),kind:z.enum(["plan","decision"]),planRevisionId:IdSchema,
 parentRevisionId:IdSchema.nullable(),decisionId:IdSchema.nullable(),actorId:IdSchema,createdAt:InstantSchema,action:z.enum(["accept","reject","modify","annotate"]).nullable(),receiptId:IdSchema.nullable()})).max(25),
 hasMore:z.boolean(),nextAfterSequence:count.min(1).nullable(),observedAt:InstantSchema}).superRefine((v,ctx)=>{
 if(v.hasMore!==(v.nextAfterSequence!==null)||v.items.some((x,i)=>i>0&&x.sequence<=v.items[i-1].sequence|| (x.kind==="plan")!==(x.decisionId===null)|| (x.kind==="plan")!==(x.action===null))||
  v.hasMore&&(v.items.length===0||v.nextAfterSequence!==v.items.at(-1)?.sequence))ctx.addIssue({code:"custom",message:"History continuation is inconsistent."});
});
export const BriefingLocatorSchema=z.strictObject({incidentId:IdSchema.transform(v=>v.toLowerCase()),mode:ModeSchema,id:IdSchema.transform(v=>v.toLowerCase())});
