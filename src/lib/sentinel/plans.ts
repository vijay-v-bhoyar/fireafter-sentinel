import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { HashSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS, utf8Bytes } from "./contracts";
import { assertEvidenceScope } from "./evidence";
import { PlanPreviewSchema, PlanDraftCommandSchema, PlanRevisionSchema } from "./plan-contracts";
export { TaskDependenciesSchema, PlanPreviewSchema, PlanDraftCommandSchema, PlanRevisionSchema } from "./plan-contracts";
import { ConstraintConfigurationSchema, proposeTaskAssignments } from "./planning";
const id = IdSchema.transform(value => value.toLowerCase()), count = z.number().int().nonnegative().safe();
const constraintRevision = z.strictObject({ id: IdSchema, scope: ScopeSchema, configuration: ConstraintConfigurationSchema, constraintHash: HashSchema, createdBy: IdSchema, createdAt: InstantSchema });
const contextSchema = z.strictObject({ scope: ScopeSchema, constraintRevision, evidenceGeneration: count, unresolvedSourceChanges: count,
  evidenceVectorHash: HashSchema, evidenceSnapshot: z.record(z.string(), z.unknown()), currentPlanRevision: IdSchema.nullable(), blockers: z.array(z.string().regex(/^[a-z_]{1,60}$/)).max(20) });
const resultSchema = z.strictObject({ revision: PlanRevisionSchema, replayed: z.boolean(), receipt: z.strictObject({ scope: ScopeSchema, commandId: IdSchema, actorId: IdSchema,
  planId: IdSchema, revisionId: IdSchema, parentRevisionId: IdSchema.nullable(), constraintRevisionId: IdSchema, evidenceGeneration: count, evidenceVectorHash: HashSchema,
  committedAt: InstantSchema, state: z.literal("draft") }) });
const pageSchema = z.strictObject({ scope: ScopeSchema, revision: PlanRevisionSchema, isCurrentRevision: z.boolean(), snapshotMatchesCurrent: z.boolean(), validity: z.enum(["current","needs_review","unavailable"]),
  approvalReady: z.boolean(), reviewState:z.enum(["draft","approved","rejected","superseded"]),isCurrentApprovedPlan:z.boolean(),terminalDecision:z.strictObject({decisionId:IdSchema,action:z.enum(["accept","reject"]),actorId:IdSchema,checkedAt:InstantSchema,committedAt:InstantSchema}).nullable(),observedAt: InstantSchema });
const messages = { AUTH_REQUIRED: "Sign in to review proposals.", SCOPE_DENIED: "This proposal is unavailable in your workspace.", INPUT_INVALID: "Proposal input is invalid or exceeds the supported bounds.",
  PLAN_CONFLICT: "The proposal, constraints or evidence changed. Refresh the preview before saving.", STORAGE_UNAVAILABLE: "Proposal storage is unavailable. Try again later." };
export class SentinelPlanError extends Error { constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "SentinelPlanError"; } }
async function actor(write: boolean) {
  const user = await getCurrentUser(); if (!user) throw new SentinelPlanError("AUTH_REQUIRED");
  if (!user.organizationId || !user.role || !(write ? ["analyst", "incident_commander"] : ["viewer", "analyst", "incident_commander"]).includes(user.role)) throw new SentinelPlanError("SCOPE_DENIED");
  return { id: id.parse(user.id), organizationId: id.parse(user.organizationId) };
}
async function rpc(name: string, params: Record<string, unknown>) {
  const db = getSupabaseAdminClient() as SupabaseClient | null; if (!db) throw new SentinelPlanError("STORAGE_UNAVAILABLE");
  const { data, error } = await db.rpc(name, params);
  if (error) throw new SentinelPlanError(error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID" : ["40001", "23505"].includes(error.code) ? "PLAN_CONFLICT" : "STORAGE_UNAVAILABLE");
  if (data !== null && utf8Bytes(JSON.stringify(data)) > SENTINEL_LIMITS.providerResponseBytes) throw new SentinelPlanError("STORAGE_UNAVAILABLE");
  return data;
}
async function context(user: { id: string; organizationId: string }, input: z.infer<typeof PlanPreviewSchema>) {
  const scope = { organizationId: user.organizationId, incidentId: input.incidentId, mode: input.mode };
  const data = await rpc("sentinel_read_plan_context", { p_actor_id: user.id, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode, p_dependencies: input.taskDependencies });
  if (data === null) throw new SentinelPlanError("SCOPE_DENIED");
  const ctx = contextSchema.parse(data); assertEvidenceScope(ctx.scope, scope); assertEvidenceScope(ctx.constraintRevision.scope, scope);
  if (ctx.evidenceSnapshot.constraintRevisionId !== ctx.constraintRevision.id || ctx.evidenceSnapshot.constraintHash !== ctx.constraintRevision.constraintHash ||
      JSON.stringify(ctx.evidenceSnapshot.taskDependencies) !== JSON.stringify(input.taskDependencies)) throw new SentinelPlanError("STORAGE_UNAVAILABLE");
  return ctx;
}
export async function previewPlanDraft(input: unknown) {
  const parsed = PlanPreviewSchema.safeParse(input); if (!parsed.success) throw new SentinelPlanError("INPUT_INVALID");
  try { const user = await actor(false), ctx = await context(user, parsed.data); return { ...ctx, allocation: proposeTaskAssignments(ctx.constraintRevision.configuration), approvalReady: false as const }; }
  catch (error) { if (error instanceof SentinelPlanError) throw error; throw new SentinelPlanError("STORAGE_UNAVAILABLE"); }
}
/** Persist a complete selected-task draft and its snapshot; policy/decision admission remains separate. */
export async function createPlanDraft(input: unknown) {
  const parsed = PlanDraftCommandSchema.safeParse(input); if (!parsed.success || utf8Bytes(JSON.stringify(parsed.data)) > SENTINEL_LIMITS.mutationBytes) throw new SentinelPlanError("INPUT_INVALID"); const c = parsed.data;
  try {
    const user = await actor(true);
    // SQL owns replay; obtain the original committed result before deriving from a newer context.
    const replay = await rpc("sentinel_find_plan_command", { p_actor_id: user.id, p_organization_id: user.organizationId, p_incident_id: c.incidentId, p_mode: c.mode, p_command_id: c.commandId,
      p_command: { parent: c.expectedCurrentPlanRevision, constraint: c.expectedConstraintRevision, generation: c.expectedEvidenceGeneration, vector: c.expectedEvidenceVectorHash, dependencies: c.taskDependencies } });
    if (replay !== null) return bindResult(resultSchema.parse(replay), c, user);
    const ctx = await context(user, c);
    if (ctx.currentPlanRevision !== c.expectedCurrentPlanRevision || ctx.constraintRevision.id !== c.expectedConstraintRevision || ctx.evidenceGeneration !== c.expectedEvidenceGeneration || ctx.evidenceVectorHash !== c.expectedEvidenceVectorHash) throw new SentinelPlanError("PLAN_CONFLICT");
    const allocation = proposeTaskAssignments(ctx.constraintRevision.configuration);
    const result = resultSchema.parse(await rpc("sentinel_create_plan_draft", { p_actor_id: user.id, p_organization_id: user.organizationId, p_incident_id: c.incidentId, p_mode: c.mode,
      p_command_id: c.commandId, p_expected_parent: c.expectedCurrentPlanRevision, p_expected_constraint: c.expectedConstraintRevision, p_expected_generation: c.expectedEvidenceGeneration,
      p_expected_vector: c.expectedEvidenceVectorHash, p_dependencies: c.taskDependencies, p_allocation: allocation }));
    const bound = bindResult(result, c, user);
    const expectedPolicy = IdSchema.nullable().parse(ctx.evidenceSnapshot.policyRevisionId ?? null);
    if (bound.revision.policyRevisionId !== expectedPolicy) throw new SentinelPlanError("STORAGE_UNAVAILABLE");
    if (!isDeepStrictEqual(bound.revision.allocation, allocation)) throw new SentinelPlanError("STORAGE_UNAVAILABLE");
    return bound;
  } catch (error) { if (error instanceof SentinelPlanError) throw error; throw new SentinelPlanError("STORAGE_UNAVAILABLE"); }
}
function bindResult(result: z.infer<typeof resultSchema>, c: z.infer<typeof PlanDraftCommandSchema>, user: { id: string; organizationId: string }) {
  const scope = { organizationId: user.organizationId, incidentId: c.incidentId, mode: c.mode }, r = result.receipt, v = result.revision;
  assertEvidenceScope(r.scope, scope); assertEvidenceScope(v.scope, scope);
  if (r.commandId !== c.commandId || r.actorId !== user.id || r.revisionId !== v.id || r.planId !== v.planId || v.createdBy !== user.id || r.committedAt !== v.createdAt ||
      r.parentRevisionId !== c.expectedCurrentPlanRevision || v.parentRevisionId !== c.expectedCurrentPlanRevision || r.constraintRevisionId !== c.expectedConstraintRevision || v.constraintRevisionId !== c.expectedConstraintRevision ||
      r.evidenceGeneration !== c.expectedEvidenceGeneration || v.evidenceGeneration !== c.expectedEvidenceGeneration || r.evidenceVectorHash !== c.expectedEvidenceVectorHash || v.evidenceVectorHash !== c.expectedEvidenceVectorHash ||
      JSON.stringify(v.taskDependencies) !== JSON.stringify(c.taskDependencies)) throw new SentinelPlanError("STORAGE_UNAVAILABLE");
  return result;
}
export async function readPlanDraft(incidentId: string, mode: string, revisionId: string | null = null) {
  const parsed = z.strictObject({ incidentId: id, mode: ModeSchema, revisionId: id.nullable() }).safeParse({ incidentId, mode, revisionId }); if (!parsed.success) throw new SentinelPlanError("INPUT_INVALID");
  try {
    const user = await actor(false), scope = { organizationId: user.organizationId, incidentId: parsed.data.incidentId, mode: parsed.data.mode };
    const data = await rpc("sentinel_read_plan_draft", { p_actor_id: user.id, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode, p_revision_id: parsed.data.revisionId });
    if (data === null) return null; const page = pageSchema.parse(data); assertEvidenceScope(page.scope, scope); assertEvidenceScope(page.revision.scope, scope);
    if (parsed.data.revisionId !== null && page.revision.id !== parsed.data.revisionId) throw new SentinelPlanError("STORAGE_UNAVAILABLE"); return page;
  } catch (error) { if (error instanceof SentinelPlanError) throw error; throw new SentinelPlanError("STORAGE_UNAVAILABLE"); }
}
