import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { AvailabilitySchema, ContentPermissionSchema, HashSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS } from "./contracts";
import { assertEvidenceScope } from "./evidence";
import { SourceConfigurationSchema } from "./publication";

export const SourceActivationSchema = z.strictObject({
  incidentId: IdSchema, mode: ModeSchema, commandId: IdSchema,
  expectedConfigRevision: IdSchema.nullable(), configuration: SourceConfigurationSchema,
}).superRefine((value, ctx) => {
  if (value.configuration.sources.some(s => {
    try { return s.documentId !== s.documentId.toLowerCase() || new URL(s.canonicalUrl).href !== s.canonicalUrl; }
    catch { return true; }
  })) {
    ctx.addIssue({ code: "custom", message: "Use canonical UUIDs and URL serialization." });
  }
});

/** Versioned compact array encoding shared with the private SQL hash helper. Source order is retained. */
export function sourceConfigurationHash(input: unknown) {
  const config = SourceConfigurationSchema.parse(input);
  return createHash("sha256").update(JSON.stringify([config.schemaVersion, config.sources.map(s =>
    [s.documentId, s.documentKey, s.canonicalUrl, s.issuer, s.jurisdiction, s.contentPermission])]), "utf8").digest("hex");
}
const ActivationResultSchema = z.strictObject({ replayed: z.boolean(), receipt: z.strictObject({
  commandId: IdSchema, actorId: IdSchema, scope: ScopeSchema, configRevision: IdSchema,
  previousConfigRevision: IdSchema.nullable(), configHash: HashSchema,
  evidenceGeneration: z.number().int().positive().safe(), changed: z.boolean(), committedAt: InstantSchema,
}) });
const VersionSummarySchema = z.strictObject({
  id: IdSchema, sourceConfigRevision: IdSchema, identityHash: HashSchema, retrievedAt: InstantSchema,
  publishedAt: InstantSchema.nullable(), effectiveFrom: InstantSchema.nullable(), effectiveUntil: InstantSchema.nullable(),
  availability: AvailabilitySchema, contentPermission: ContentPermissionSchema,
  normalizedBytes: z.number().int().min(0).max(SENTINEL_LIMITS.sourceBytes),
});
const RetrievalSummarySchema = z.strictObject({
  id: IdSchema, checkedVersionId: IdSchema.nullable(), requestedAt: InstantSchema, completedAt: InstantSchema,
  outcome: z.enum(["version", "same_version", "incomplete", "failed", "withdrawn"]), safeErrorCode: z.string().max(100).nullable(),
}).refine(v => Date.parse(v.completedAt) >= Date.parse(v.requestedAt), "Invalid retrieval interval.");
export const EvidenceSummarySchema = z.strictObject({
  scope: ScopeSchema, sourceConfigRevision: IdSchema.nullable(), configHash: HashSchema.nullable(),
  configuration: SourceConfigurationSchema.nullable(), evidenceGeneration: z.number().int().nonnegative().safe(),
  unresolvedSourceChanges: z.number().int().nonnegative().safe(), observedAt: InstantSchema,
  documents: z.array(z.strictObject({ documentId: IdSchema, currentVersion: VersionSummarySchema.nullable(),
    matchesConfiguration: z.boolean(), latestRetrieval: RetrievalSummarySchema.nullable() })).max(SENTINEL_LIMITS.documents),
});
export const SourceChangePageSchema = z.strictObject({
  scope: ScopeSchema, evidenceGeneration: z.number().int().nonnegative().safe(),
  unresolvedSourceChanges: z.number().int().nonnegative().safe(), observedAt: InstantSchema,
  items: z.array(z.strictObject({ id: IdSchema, documentId: IdSchema, versionId: IdSchema,
    previousVersionId: IdSchema.nullable(), runId: IdSchema, evidenceGeneration: z.number().int().positive().safe(),
    createdAt: InstantSchema })).max(SENTINEL_LIMITS.pageRows),
  hasMore: z.boolean(), nextAfterGeneration: z.number().int().positive().safe().nullable(),
});

export class SentinelSourceError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "SCOPE_DENIED" | "INPUT_INVALID" | "SOURCE_CONFLICT" | "STORAGE_UNAVAILABLE") {
    super(code === "AUTH_REQUIRED" ? "Sign in to review sources." : code === "SCOPE_DENIED" ? "Sources are unavailable in this workspace."
      : code === "INPUT_INVALID" ? "Source input is invalid." : code === "SOURCE_CONFLICT" ? "Source configuration changed. Review it again."
        : "Source storage is unavailable. Try again later.");
    this.name = "SentinelSourceError";
  }
}
async function sourceContext(incidentId: string, mode: z.infer<typeof ModeSchema>, write = false) {
  const user = await getCurrentUser();
  if (!user) throw new SentinelSourceError("AUTH_REQUIRED");
  if (!user.organizationId || !user.role || (write ? user.role !== "incident_commander" : !["viewer", "analyst", "incident_commander"].includes(user.role))) {
    throw new SentinelSourceError("SCOPE_DENIED");
  }
  const scope = ScopeSchema.parse({ organizationId: user.organizationId, incidentId, mode });
  const db = getSupabaseAdminClient() as SupabaseClient | null;
  if (!db) throw new SentinelSourceError("STORAGE_UNAVAILABLE");
  return { scope, db, actorId: IdSchema.parse(user.id) };
}
function databaseError(code: string | undefined): never {
  throw new SentinelSourceError(code === "42501" ? "SCOPE_DENIED" : code === "22023" ? "INPUT_INVALID"
    : ["40001", "23505"].includes(code ?? "") ? "SOURCE_CONFLICT" : "STORAGE_UNAVAILABLE");
}
function safeFailure(error: unknown): never {
  if (error instanceof SentinelSourceError) throw error;
  throw new SentinelSourceError("STORAGE_UNAVAILABLE");
}

/** Private operator command. SQL additionally requires owner-managed source-operator admission. No browser/model endpoint. */
export async function activateSourceConfiguration(input: unknown) {
  const parsed = SourceActivationSchema.safeParse(input);
  if (!parsed.success) throw new SentinelSourceError("INPUT_INVALID");
  const command = parsed.data;
  try {
    const { scope, db, actorId } = await sourceContext(command.incidentId, command.mode, true);
    const configHash = sourceConfigurationHash(command.configuration);
    const { data, error } = await db.rpc("sentinel_activate_source_config", {
      p_actor_id: actorId, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode,
      p_command_id: command.commandId, p_expected_config: command.expectedConfigRevision,
      p_configuration: command.configuration, p_config_hash: configHash,
    });
    if (error) databaseError(error.code);
    const result = ActivationResultSchema.parse(data), r = result.receipt;
    assertEvidenceScope(r.scope, scope);
    if (r.actorId !== actorId || r.commandId !== command.commandId || r.configHash !== configHash ||
        r.previousConfigRevision !== command.expectedConfigRevision || r.changed !== (r.configRevision !== r.previousConfigRevision)) {
      throw new SentinelSourceError("STORAGE_UNAVAILABLE");
    }
    return result;
  } catch (error) { safeFailure(error); }
}

/** Member-only metadata projection; excludes retained text, prompts, provider request IDs and worker identities. */
export async function readEvidenceSummary(incidentId: string, mode: string) {
  const request = z.strictObject({ incidentId: IdSchema, mode: ModeSchema }).safeParse({ incidentId, mode });
  if (!request.success) throw new SentinelSourceError("INPUT_INVALID");
  try {
    const { scope, db, actorId } = await sourceContext(request.data.incidentId, request.data.mode);
    const { data, error } = await db.rpc("sentinel_read_evidence_summary", {
      p_actor_id: actorId, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode,
    });
    if (error) databaseError(error.code);
    if (data === null) return null;
    const result = EvidenceSummarySchema.parse(data);
    assertEvidenceScope(result.scope, scope);
    const config = result.configuration;
    if (Boolean(config) !== Boolean(result.sourceConfigRevision) || Boolean(config) !== Boolean(result.configHash) ||
        (config ? result.configHash !== sourceConfigurationHash(config) || result.documents.length !== config.sources.length : result.documents.length !== 0)) {
      throw new SentinelSourceError("STORAGE_UNAVAILABLE");
    }
    result.documents.forEach((doc, index) => {
      if (doc.documentId !== config?.sources[index].documentId || doc.matchesConfiguration !== Boolean(doc.currentVersion &&
          doc.currentVersion.sourceConfigRevision === result.sourceConfigRevision)) throw new SentinelSourceError("STORAGE_UNAVAILABLE");
    });
    return result;
  } catch (error) { safeFailure(error); }
}

/** Internal keyset cursor is a generation number; callers cannot supply scope or authorization. */
export async function readSourceChangePage(incidentId: string, mode: string, afterGeneration = 0) {
  const request = z.strictObject({ incidentId: IdSchema, mode: ModeSchema, afterGeneration: z.number().int().nonnegative().safe() })
    .safeParse({ incidentId, mode, afterGeneration });
  if (!request.success) throw new SentinelSourceError("INPUT_INVALID");
  try {
    const { scope, db, actorId } = await sourceContext(request.data.incidentId, request.data.mode);
    const { data, error } = await db.rpc("sentinel_read_source_changes", {
      p_actor_id: actorId, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId, p_mode: scope.mode,
      p_after_generation: request.data.afterGeneration,
    });
    if (error) databaseError(error.code);
    if (data === null) return null;
    const result = SourceChangePageSchema.parse(data);
    assertEvidenceScope(result.scope, scope);
    let previous = request.data.afterGeneration;
    const ids = new Set<string>();
    for (const item of result.items) {
      if (item.evidenceGeneration <= previous || item.evidenceGeneration > result.evidenceGeneration || ids.has(item.id)) {
        throw new SentinelSourceError("STORAGE_UNAVAILABLE");
      }
      previous = item.evidenceGeneration; ids.add(item.id);
    }
    if (result.hasMore !== (result.nextAfterGeneration !== null) || (result.hasMore &&
        (result.items.length !== SENTINEL_LIMITS.pageRows || result.nextAfterGeneration !== previous))) {
      throw new SentinelSourceError("STORAGE_UNAVAILABLE");
    }
    return result;
  } catch (error) { safeFailure(error); }
}
