import "server-only";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { assertEvidenceScope } from "./evidence";
import { HashSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS, utf8Bytes } from "./contracts";
import { PolicyCommandSchema, PolicyConfigurationSchema } from "./policy-contracts";
const id = IdSchema.transform(v => v.toLowerCase()), count = z.number().int().nonnegative().safe();
const revisionSchema = z.strictObject({ id: IdSchema, scope: ScopeSchema, sourceConfigurationId: IdSchema, configuration: PolicyConfigurationSchema,
  policyHash: HashSchema, createdBy: IdSchema, createdAt: InstantSchema });
const resultSchema = z.strictObject({ revision: revisionSchema, replayed: z.boolean(), receipt: z.strictObject({ scope: ScopeSchema,
  commandId: IdSchema, actorId: IdSchema, revisionId: IdSchema, previousRevisionId: IdSchema.nullable(), sourceConfigurationId: IdSchema,
  changed: z.boolean(), committedAt: InstantSchema, evidenceGeneration: count, unresolvedSourceChanges: count }) });
const pageSchema = z.strictObject({ scope: ScopeSchema, revision: revisionSchema.nullable(), evidenceGeneration: count,
  unresolvedSourceChanges: count, observedAt: InstantSchema });
const issue = z.string().regex(/^[a-z_]{1,80}$/);
const admissionSchema = z.strictObject({ scope: ScopeSchema, planRevisionId: IdSchema, policyRevisionId: IdSchema.nullable(),
  currentPlanRevisionId: IdSchema.nullable(), evidenceGeneration: count, evidenceVectorHash: HashSchema.nullable(),
  checkedAt: InstantSchema, timeBasis: z.enum(["database", "scenario"]), eligible: z.boolean(), approvalReady: z.literal(false),
  blockers: z.array(issue).max(64), documentChecks: z.array(z.strictObject({ documentId: IdSchema, versionId: IdSchema.nullable(), issues: z.array(issue).max(20) })).max(5),
  nativeChecks: z.array(z.strictObject({ sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/), snapshotId: IdSchema.nullable(), issues: z.array(issue).max(20) })).max(10) });
const messages = { AUTH_REQUIRED: "Sign in to review policy.", SCOPE_DENIED: "Policy is unavailable in your workspace.", INPUT_INVALID: "Policy input is invalid or exceeds the supported bounds.",
  POLICY_CONFLICT: "Policy or evidence changed. Refresh before saving.", STORAGE_UNAVAILABLE: "Policy storage is unavailable. Try again later." };
export class SentinelPolicyError extends Error { constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "SentinelPolicyError"; } }
async function actor(write: boolean) {
  const u = await getCurrentUser(); if (!u) throw new SentinelPolicyError("AUTH_REQUIRED");
  if (!u.organizationId || !u.role || !(write ? ["incident_commander"] : ["incident_commander", "analyst", "viewer"]).includes(u.role)) throw new SentinelPolicyError("SCOPE_DENIED");
  return { id: id.parse(u.id), organizationId: id.parse(u.organizationId) };
}
async function rpc(name: string, params: Record<string, unknown>) {
  const db = getSupabaseAdminClient() as SupabaseClient | null; if (!db) throw new SentinelPolicyError("STORAGE_UNAVAILABLE");
  const { data, error } = await db.rpc(name, params);
  if (error) throw new SentinelPolicyError(error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID" : ["40001", "23505"].includes(error.code) ? "POLICY_CONFLICT" : "STORAGE_UNAVAILABLE");
  if (data !== null && utf8Bytes(JSON.stringify(data)) > SENTINEL_LIMITS.providerResponseBytes) throw new SentinelPolicyError("STORAGE_UNAVAILABLE");
  return data;
}
export async function recordPolicy(input: unknown) {
  const parsed = PolicyCommandSchema.safeParse(input); if (!parsed.success || utf8Bytes(JSON.stringify(parsed.data)) > SENTINEL_LIMITS.mutationBytes) throw new SentinelPolicyError("INPUT_INVALID");
  try {
    const c = parsed.data, u = await actor(true), scope = { organizationId: u.organizationId, incidentId: c.incidentId, mode: c.mode };
    const result = resultSchema.parse(await rpc("sentinel_record_policy", { p_actor_id: u.id, p_organization_id: u.organizationId, p_incident_id: c.incidentId, p_mode: c.mode,
      p_command_id: c.commandId, p_expected_policy: c.expectedPolicyRevision, p_expected_source: c.expectedSourceConfiguration, p_expected_generation: c.expectedEvidenceGeneration, p_configuration: c.configuration }));
    const r = result.receipt, v = result.revision; assertEvidenceScope(r.scope, scope); assertEvidenceScope(v.scope, scope);
    if (r.commandId !== c.commandId || r.actorId !== u.id || r.revisionId !== v.id || r.previousRevisionId !== c.expectedPolicyRevision ||
        r.sourceConfigurationId !== c.expectedSourceConfiguration || v.sourceConfigurationId !== c.expectedSourceConfiguration ||
        (r.changed && (v.createdBy !== u.id || v.createdAt !== r.committedAt || v.id === c.expectedPolicyRevision)) ||
        (!r.changed && v.id !== c.expectedPolicyRevision) || !isDeepStrictEqual(v.configuration, c.configuration) ||
        r.evidenceGeneration !== c.expectedEvidenceGeneration + (r.changed ? 1 : 0)) throw new SentinelPolicyError("STORAGE_UNAVAILABLE");
    return result;
  } catch (error) { if (error instanceof SentinelPolicyError) throw error; throw new SentinelPolicyError("STORAGE_UNAVAILABLE"); }
}
export async function readPolicy(incidentId: string, mode: string) {
  const parsed = z.strictObject({ incidentId: id, mode: ModeSchema }).safeParse({ incidentId, mode }); if (!parsed.success) throw new SentinelPolicyError("INPUT_INVALID");
  try {
    const u = await actor(false), scope = { organizationId: u.organizationId, ...parsed.data };
    const data = await rpc("sentinel_read_policy", { p_actor_id: u.id, p_organization_id: u.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode });
    if (data === null) return null; const page = pageSchema.parse(data); assertEvidenceScope(page.scope, scope);
    if (page.revision) assertEvidenceScope(page.revision.scope, scope); return page;
  } catch (error) { if (error instanceof SentinelPolicyError) throw error; throw new SentinelPolicyError("STORAGE_UNAVAILABLE"); }
}
export async function previewPlanAdmission(input: unknown) {
  const parsed = z.strictObject({ incidentId: id, mode: ModeSchema, planRevisionId: id }).safeParse(input); if (!parsed.success) throw new SentinelPolicyError("INPUT_INVALID");
  try {
    const u = await actor(false), c = parsed.data, scope = { organizationId: u.organizationId, incidentId: c.incidentId, mode: c.mode };
    const data = await rpc("sentinel_preview_plan_admission", { p_actor_id: u.id, p_organization_id: u.organizationId, p_incident_id: c.incidentId, p_mode: c.mode, p_revision_id: c.planRevisionId });
    if (data === null) return null; const result = admissionSchema.parse(data); assertEvidenceScope(result.scope, scope);
    if (result.planRevisionId !== c.planRevisionId || result.eligible !== (result.blockers.length === 0) ||
        (result.eligible && (result.policyRevisionId === null || result.evidenceVectorHash === null || result.currentPlanRevisionId !== result.planRevisionId ||
          !result.documentChecks.length || !result.nativeChecks.length || result.timeBasis !== (c.mode === "live" ? "database" : "scenario"))) ||
        (result.eligible && [...result.documentChecks, ...result.nativeChecks].some(v => v.issues.length))) throw new SentinelPolicyError("STORAGE_UNAVAILABLE");
    return result;
  } catch (error) { if (error instanceof SentinelPolicyError) throw error; throw new SentinelPolicyError("STORAGE_UNAVAILABLE"); }
}
