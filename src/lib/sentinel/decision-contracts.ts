import { z } from "zod";
import { IdSchema, HashSchema, ModeSchema, CorrectionTextSchema, ScopeSchema, InstantSchema } from "./contracts";
import { TaskAssignmentSchema } from "./planning";
import { FeedbackInputSchema } from "./feedback-contracts";
const id=IdSchema.transform(v=>v.toLowerCase());
const note=CorrectionTextSchema.transform(v=>v.trim()).refine(v=>v.length>0 && !v.includes("\0") &&
 new TextDecoder("utf-8",{ignoreBOM:true}).decode(new TextEncoder().encode(v))===v);
const modifications=z.strictObject({assignments:z.array(TaskAssignmentSchema).min(1).max(10)
 .refine(v=>new Set(v.map(a=>a.taskId)).size===v.length).transform(v=>[...v].sort((a,b)=>a.taskId.localeCompare(b.taskId)))});
export const DecisionCommandSchema=z.strictObject({incidentId:id,mode:ModeSchema,planRevisionId:id,commandId:id,expectedPlanRevision:id,
 expectedEvidenceGeneration:z.number().int().nonnegative().safe(),expectedEvidenceVectorHash:HashSchema,expectedConstraintRevision:id,expectedPolicyRevision:id.nullable(),
 action:z.enum(["accept","reject","modify","annotate"]),note,modifications:modifications.nullable(),feedback:FeedbackInputSchema.optional()}).superRefine((v,c)=>{
 if(v.planRevisionId!==v.expectedPlanRevision || (v.action==="modify")!==(v.modifications!==null))
  c.addIssue({code:"custom",message:"Decision target or modifications are invalid."});
});
export type DecisionCommand=z.infer<typeof DecisionCommandSchema>;

const count=z.number().int().nonnegative().safe();
export const DecisionSchema=z.strictObject({id:IdSchema,scope:ScopeSchema,receiptId:IdSchema,auditId:IdSchema,planId:IdSchema,planRevisionId:IdSchema,newPlanRevisionId:IdSchema.nullable(),
 actorId:IdSchema,action:z.enum(["accept","reject","modify","annotate"]),note:z.string().min(1).max(2048),reviewedEvidenceGeneration:count,reviewedEvidenceVectorHash:HashSchema,constraintRevisionId:IdSchema,policyRevisionId:IdSchema.nullable(),
 checkedAt:InstantSchema,committedAt:InstantSchema,timeBasis:z.enum(["database","scenario"])});
export const DecisionReceiptSchema=z.strictObject({id:IdSchema,scope:ScopeSchema,commandId:IdSchema,actorId:IdSchema,decisionId:IdSchema,auditId:IdSchema,reviewedPlanRevision:IdSchema,newPlanRevisionId:IdSchema.nullable(),
 reviewedEvidenceGeneration:count,reviewedEvidenceVectorHash:HashSchema,action:z.enum(["accept","reject","modify","annotate"]),checkedAt:InstantSchema,committedAt:InstantSchema});
export const FinalDecisionValidationSchema=z.strictObject({kind:z.literal("final_admission"),decisionId:IdSchema,planRevisionId:IdSchema,checkedAt:InstantSchema,timeBasis:z.enum(["database","scenario"]),evidenceVectorHash:HashSchema,eligible:z.literal(true)});
