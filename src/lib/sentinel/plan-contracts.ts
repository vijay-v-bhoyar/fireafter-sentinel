import { z } from "zod";
import { HashSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS } from "./contracts";
import { TaskAssignmentSchema } from "./planning";
const id=IdSchema.transform(v=>v.toLowerCase()), count=z.number().int().nonnegative().safe();
export const TaskDependenciesSchema = z.array(z.strictObject({ taskId: id, claimIds: z.array(id).max(SENTINEL_LIMITS.pageRows) }))
  .min(1).max(SENTINEL_LIMITS.tasks).superRefine((value, ctx) => {
    if (new Set(value.map(v => v.taskId)).size !== value.length || value.some(v => new Set(v.claimIds).size !== v.claimIds.length) ||
        new Set(value.flatMap(v => v.claimIds)).size > SENTINEL_LIMITS.pageRows) ctx.addIssue({ code: "custom", message: "Dependency identity or capacity is invalid." });
  }).transform(value => value.map(v => ({ ...v, claimIds: [...v.claimIds].sort() })).sort((a, b) => a.taskId.localeCompare(b.taskId)));
export const PlanPreviewSchema = z.strictObject({ incidentId: id, mode: ModeSchema, taskDependencies: TaskDependenciesSchema });
export const PlanDraftCommandSchema = PlanPreviewSchema.extend({ commandId: id, expectedCurrentPlanRevision: id.nullable(), expectedConstraintRevision: id,
  expectedEvidenceGeneration: count, expectedEvidenceVectorHash: HashSchema });
const allocationSchema = z.strictObject({ status: z.enum(["feasible", "infeasible", "incomplete"]), selectedTaskIds: z.array(IdSchema).min(1).max(SENTINEL_LIMITS.tasks),
  assignments: z.array(TaskAssignmentSchema).max(SENTINEL_LIMITS.tasks), issues: z.array(z.strictObject({ code: z.string().regex(/^[A-Z_]{1,60}$/), taskId: IdSchema.optional(), crewId: IdSchema.optional() })).max(32) });
export const PlanRevisionSchema = z.strictObject({ id: IdSchema, planId: IdSchema, scope: ScopeSchema, parentRevisionId: IdSchema.nullable(), constraintRevisionId: IdSchema,
  evidenceGeneration: count, evidenceVectorHash: HashSchema, policyRevisionId: IdSchema.nullable(), state: z.literal("draft"), approvalReady: z.literal(false),
  createdBy: IdSchema, createdAt: InstantSchema, allocation: allocationSchema, taskDependencies: TaskDependenciesSchema, blockers: z.array(z.string().regex(/^[a-z_]{1,60}$/)).max(20) });
