import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getSupabaseAdminClient } from "../supabase";
import {
  ContentPermissionSchema, DocumentVersionSchema, HashSchema, IdSchema, InstantSchema,
  RegisteredUrlSchema, ScopeSchema, SENTINEL_LIMITS, WorkerMutationSchema,
} from "./contracts";
import { assertEvidenceScope, assertVersionIntegrity } from "./evidence";
import { SentinelRunError } from "./runs";

export const SourceRegistrationSchema = z.strictObject({
  documentId: IdSchema, documentKey: z.string().trim().min(1).max(200),
  canonicalUrl: RegisteredUrlSchema, issuer: z.string().trim().min(1).max(200),
  jurisdiction: z.string().trim().min(1).max(200), contentPermission: ContentPermissionSchema,
});
export const SourceConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1), sources: z.array(SourceRegistrationSchema).min(1).max(SENTINEL_LIMITS.documents),
}).refine(value => ["documentId", "documentKey", "canonicalUrl"].every(key =>
  new Set(value.sources.map(source => source[key as keyof typeof source])).size === value.sources.length),
"Source identities, keys and URLs must be unique.");

const RetrievalFields = {
  documentId: IdSchema, requestedAt: InstantSchema,
  observedBytes: z.number().int().min(0).max(SENTINEL_LIMITS.providerResponseBytes),
  providerRequestId: z.string().min(1).max(200).nullable(),
};
export const PublicationObservationSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ ...RetrievalFields, outcome: z.literal("observed"), version: DocumentVersionSchema }),
  z.strictObject({ ...RetrievalFields, outcome: z.enum(["failed", "incomplete"]),
    safeErrorCode: z.enum(["SOURCE_UNAVAILABLE", "PROVIDER_TIMEOUT", "PROVIDER_PARTIAL", "UNSUPPORTED_FORMAT", "INPUT_INVALID"]) }),
]);
export const EvidencePublicationSchema = WorkerMutationSchema.extend({
  commandId: IdSchema, observations: z.array(PublicationObservationSchema).min(1).max(SENTINEL_LIMITS.documents),
}).superRefine((value, context) => {
  if (new Set(value.observations.map(item => item.documentId)).size !== value.observations.length ||
      value.observations.reduce((sum, item) => sum + (item.outcome === "observed" ? item.version.normalizedBytes : 0), 0) > SENTINEL_LIMITS.aggregateSourceBytes ||
      Buffer.byteLength(JSON.stringify(value.observations), "utf8") > SENTINEL_LIMITS.providerResponseBytes) {
    context.addIssue({ code: "custom", message: "Publication exceeds unique-document or aggregate text limits." });
  }
  for (const item of value.observations) {
    if (item.outcome !== "observed") continue;
    try { assertEvidenceScope(item.version.scope, value.scope); assertVersionIntegrity(item.version); }
    catch { context.addIssue({ code: "custom", message: "Publication version scope or integrity is invalid." }); }
    if (item.documentId !== item.version.documentId || Date.parse(item.version.retrievedAt) < Date.parse(item.requestedAt)) {
      context.addIssue({ code: "custom", message: "Publication version or retrieval interval is misbound." });
    }
  }
});
export type EvidencePublication = z.infer<typeof EvidencePublicationSchema>;
export const PublicationReceiptSchema = z.strictObject({
  commandId: IdSchema, runId: IdSchema, scope: ScopeSchema, fence: z.number().int().positive().safe(),
  committedAt: InstantSchema, evidenceGeneration: z.number().int().nonnegative().safe(),
  unresolvedSourceChanges: z.number().int().nonnegative().safe(),
  observations: z.array(z.strictObject({
    documentId: IdSchema, eventId: IdSchema, versionId: IdSchema.nullable(), previousVersionId: IdSchema.nullable(),
    identityHash: HashSchema.nullable(), markerId: IdSchema.nullable(), changed: z.boolean(),
    outcome: z.enum(["version", "same_version", "withdrawn", "incomplete", "failed"]),
  })).min(1).max(SENTINEL_LIMITS.documents),
});
export const PublicationResultSchema = z.strictObject({ receipt: PublicationReceiptSchema, replayed: z.boolean() });

/** Private worker command, not a model/browser write tool. SQL rechecks the stored run actor and lease. */
export async function publishEvidence(input: unknown) {
  const parsed = EvidencePublicationSchema.safeParse(input);
  if (!parsed.success) throw new SentinelRunError("INPUT_INVALID");
  const command = parsed.data;
  try {
    const db = getSupabaseAdminClient() as SupabaseClient | null;
    if (!db) throw new SentinelRunError("STORAGE_UNAVAILABLE");
    const { data, error } = await db.rpc("sentinel_publish_evidence", {
      p_organization_id: command.scope.organizationId, p_incident_id: command.scope.incidentId, p_mode: command.scope.mode,
      p_run_id: command.runId, p_owner: command.owner, p_fence: command.fence,
      p_command_id: command.commandId, p_observations: command.observations,
    });
    if (error) throw new SentinelRunError(error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID"
      : ["40001", "23505"].includes(error.code) ? "RUN_CONFLICT" : "STORAGE_UNAVAILABLE");
    const result = PublicationResultSchema.safeParse(data);
    if (!result.success) throw new SentinelRunError("STORAGE_UNAVAILABLE");
    const { receipt, replayed } = result.data;
    assertEvidenceScope(receipt.scope, command.scope);
    if (receipt.commandId !== command.commandId || receipt.runId !== command.runId ||
        receipt.fence > command.fence || (!replayed && receipt.fence !== command.fence) || receipt.observations.length !== command.observations.length ||
        receipt.evidenceGeneration < receipt.observations.filter(item => item.changed).length ||
        receipt.unresolvedSourceChanges < receipt.observations.filter(item => item.changed).length ||
        new Set(receipt.observations.map(item => item.eventId)).size !== receipt.observations.length) {
      throw new SentinelRunError("STORAGE_UNAVAILABLE");
    }
    receipt.observations.forEach((actual, index) => {
      const expected = command.observations[index];
      if (actual.documentId !== expected.documentId || (expected.outcome === "observed"
        ? actual.identityHash !== expected.version.identityHash || !actual.versionId || actual.changed !== Boolean(actual.markerId) ||
          actual.changed !== (actual.previousVersionId !== actual.versionId) ||
          actual.outcome !== (expected.version.availability === "withdrawn" ? "withdrawn" : expected.version.availability === "incomplete" ? "incomplete" : actual.changed ? "version" : "same_version")
        : actual.outcome !== expected.outcome || actual.versionId !== null || actual.identityHash !== null || actual.changed || actual.markerId !== null)) {
        throw new SentinelRunError("STORAGE_UNAVAILABLE");
      }
    });
    return result.data;
  } catch (error) {
    if (error instanceof SentinelRunError) throw error;
    throw new SentinelRunError("STORAGE_UNAVAILABLE");
  }
}
