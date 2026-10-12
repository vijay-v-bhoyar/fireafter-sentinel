import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { HashSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS, utf8Bytes } from "./contracts";
import { assertEvidenceScope } from "./evidence";
import { ConstraintConfigurationSchema } from "./planning";

const id = IdSchema.transform(value => value.toLowerCase()), count = z.number().int().nonnegative().safe();
export const ConstraintCommandSchema = z.strictObject({ incidentId: id, mode: ModeSchema, commandId: id, expectedConstraintRevision: id.nullable(), configuration: ConstraintConfigurationSchema });
const revisionSchema = z.strictObject({ id: IdSchema, scope: ScopeSchema, configuration: ConstraintConfigurationSchema, constraintHash: HashSchema, createdBy: IdSchema, createdAt: InstantSchema });
const resultSchema = z.strictObject({ revision: revisionSchema, replayed: z.boolean(), receipt: z.strictObject({ scope: ScopeSchema, commandId: IdSchema, actorId: IdSchema,
  revisionId: IdSchema, previousRevisionId: IdSchema.nullable(), changed: z.boolean(), committedAt: InstantSchema, evidenceGeneration: count, unresolvedSourceChanges: count }) });
const pageSchema = z.strictObject({ scope: ScopeSchema, revision: revisionSchema.nullable(), evidenceGeneration: count, unresolvedSourceChanges: count, observedAt: InstantSchema });
const messages = { AUTH_REQUIRED: "Sign in to manage plan constraints.", SCOPE_DENIED: "Constraints are unavailable in your workspace.", INPUT_INVALID: "Constraint input is invalid or exceeds the supported bounds.",
  CONSTRAINT_CONFLICT: "The constraints or command changed. Read the current revision before saving.", STORAGE_UNAVAILABLE: "Constraint storage is unavailable. Try again later." };
export class SentinelConstraintError extends Error { constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "SentinelConstraintError"; } }
async function actor(write: boolean) {
  const user = await getCurrentUser(); if (!user) throw new SentinelConstraintError("AUTH_REQUIRED");
  if (!user.organizationId || !user.role || !(write ? ["analyst", "incident_commander"] : ["viewer", "analyst", "incident_commander"]).includes(user.role)) throw new SentinelConstraintError("SCOPE_DENIED");
  return { id: id.parse(user.id), organizationId: id.parse(user.organizationId) };
}
async function rpc(name: string, params: Record<string, unknown>) {
  const db = getSupabaseAdminClient() as SupabaseClient | null; if (!db) throw new SentinelConstraintError("STORAGE_UNAVAILABLE");
  const { data, error } = await db.rpc(name, params);
  if (error) throw new SentinelConstraintError(error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID" : ["40001", "23505"].includes(error.code) ? "CONSTRAINT_CONFLICT" : "STORAGE_UNAVAILABLE");
  return data;
}
/** Immutable operator-authored inputs; updating them fences old proposals, never approves one. */
export async function recordConstraints(input: unknown) {
  const parsed = ConstraintCommandSchema.safeParse(input); if (!parsed.success) throw new SentinelConstraintError("INPUT_INVALID"); const c = parsed.data;
  try {
    const user = await actor(true), scope = { organizationId: user.organizationId, incidentId: c.incidentId, mode: c.mode };
    const result = resultSchema.parse(await rpc("sentinel_record_constraints", { p_actor_id: user.id, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId,
      p_mode: scope.mode, p_command_id: c.commandId, p_expected_revision: c.expectedConstraintRevision, p_configuration: c.configuration }));
    assertEvidenceScope(result.revision.scope, scope); assertEvidenceScope(result.receipt.scope, scope);
    const receipt = result.receipt;
    if (receipt.actorId !== user.id || receipt.commandId !== c.commandId || receipt.previousRevisionId !== c.expectedConstraintRevision || receipt.revisionId !== result.revision.id ||
        (receipt.changed ? receipt.revisionId === c.expectedConstraintRevision || result.revision.createdBy !== user.id || result.revision.createdAt !== receipt.committedAt
          : receipt.revisionId !== c.expectedConstraintRevision) || JSON.stringify(result.revision.configuration) !== JSON.stringify(c.configuration)) throw new SentinelConstraintError("STORAGE_UNAVAILABLE");
    return result;
  } catch (error) { if (error instanceof SentinelConstraintError) throw error; throw new SentinelConstraintError("STORAGE_UNAVAILABLE"); }
}
export async function readConstraints(incidentId: string, mode: string) {
  const parsed = z.strictObject({ incidentId: id, mode: ModeSchema }).safeParse({ incidentId, mode }); if (!parsed.success) throw new SentinelConstraintError("INPUT_INVALID");
  try {
    const user = await actor(false), scope = { organizationId: user.organizationId, incidentId: parsed.data.incidentId, mode: parsed.data.mode };
    const data = await rpc("sentinel_read_constraints", { p_actor_id: user.id, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode });
    if (data === null) return null;
    if (utf8Bytes(JSON.stringify(data)) > SENTINEL_LIMITS.providerResponseBytes) throw new SentinelConstraintError("STORAGE_UNAVAILABLE");
    const page = pageSchema.parse(data); assertEvidenceScope(page.scope, scope); if (page.revision) assertEvidenceScope(page.revision.scope, scope); return page;
  } catch (error) { if (error instanceof SentinelConstraintError) throw error; throw new SentinelConstraintError("STORAGE_UNAVAILABLE"); }
}
