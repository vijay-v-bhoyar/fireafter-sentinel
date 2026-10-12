import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { ClaimSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS, WorkerMutationSchema, utf8Bytes } from "./contracts";
import { assertEvidenceScope, evidenceHash, normalizeEvidenceText } from "./evidence";
import { SentinelRunError } from "./runs";

const canonicalId = IdSchema.transform(value => value.toLowerCase());
const boundedText = (bytes: number) => z.string().max(bytes).refine(value => utf8Bytes(value) <= bytes && !value.includes("\0") &&
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value, "Text exceeds its UTF-8 or Unicode bound.");
export const ClaimDraftSchema = z.strictObject({
  id: canonicalId, documentVersionId: canonicalId,
  excerptStart: ClaimSchema.shape.excerptStart, excerptEnd: ClaimSchema.shape.excerptEnd,
  excerpt: boundedText(SENTINEL_LIMITS.sourceBytes).min(1), excerptHash: ClaimSchema.shape.excerptHash,
  kind: ClaimSchema.shape.kind, claimText: boundedText(8000).min(1).max(2000).refine(value => value === value.trim()),
  entityIds: z.array(canonicalId).max(SENTINEL_LIMITS.tasks),
  modelVersion: ClaimSchema.shape.modelVersion, promptVersion: ClaimSchema.shape.promptVersion,
}).superRefine((value, ctx) => {
  if (value.excerptEnd <= value.excerptStart || utf8Bytes(value.excerpt) !== value.excerptEnd - value.excerptStart ||
      evidenceHash(value.excerpt) !== value.excerptHash || new Set(value.entityIds).size !== value.entityIds.length) {
    ctx.addIssue({ code: "custom", message: "Claim citation or entity identity is invalid." });
  }
});
export type ClaimDraft = z.infer<typeof ClaimDraftSchema>;
export const ClaimPublicationSchema = WorkerMutationSchema.extend({
  commandId: canonicalId, expectedEvidenceGeneration: z.number().int().nonnegative().safe(),
  versionIds: z.array(canonicalId).min(1).max(SENTINEL_LIMITS.documents),
  claims: z.array(ClaimDraftSchema).max(SENTINEL_LIMITS.pageRows),
  // Ephemeral verification text is not included in immutable commands, receipts or projections.
  transientTexts: z.record(IdSchema.refine(id => id === id.toLowerCase()), boundedText(SENTINEL_LIMITS.sourceBytes)
    .refine(value => normalizeEvidenceText(value) === value)).default({}),
}).superRefine((value, ctx) => {
  const payload = { expectedEvidenceGeneration: value.expectedEvidenceGeneration, versionIds: value.versionIds, claims: value.claims };
  if (new Set(value.versionIds).size !== value.versionIds.length || new Set(value.claims.map(c => c.id)).size !== value.claims.length ||
      value.claims.some(c => !value.versionIds.includes(c.documentVersionId)) ||
      Object.keys(value.transientTexts).some(id => !value.versionIds.includes(id)) ||
      Object.values(value.transientTexts).reduce((n, text) => n + utf8Bytes(text), 0) > SENTINEL_LIMITS.aggregateSourceBytes ||
      utf8Bytes(JSON.stringify(value.transientTexts)) > SENTINEL_LIMITS.providerResponseBytes || utf8Bytes(JSON.stringify(payload)) > SENTINEL_LIMITS.mutationBytes) {
    ctx.addIssue({ code: "custom", message: "Claim publication exceeds its scoped document, identity or transport bounds." });
  }
});
export const ClaimPublicationResultSchema = z.strictObject({
  replayed: z.boolean(), receipt: z.strictObject({
    commandId: IdSchema, runId: IdSchema, scope: ScopeSchema, fence: z.number().int().positive().safe(),
    committedAt: InstantSchema, evidenceGeneration: z.number().int().nonnegative().safe(),
    unresolvedSourceChanges: z.number().int().nonnegative().safe(),
    reopenedMarkers: z.number().int().positive().safe().optional(),
    versionIds: z.array(IdSchema).min(1).max(SENTINEL_LIMITS.documents), claimIds: z.array(IdSchema).max(SENTINEL_LIMITS.pageRows),
    semanticSupport: z.literal("unreviewed"),
  }),
});
export const ClaimPageSchema = z.strictObject({
  scope: ScopeSchema, versionId: IdSchema, evidenceGeneration: z.number().int().nonnegative().safe(),
  unresolvedSourceChanges: z.number().int().nonnegative().safe(), currentEvidence: z.boolean(), observedAt: InstantSchema,
  items: z.array(z.strictObject({ sequence: z.number().int().positive().safe(), claim: ClaimSchema,
    citationVerified: z.literal(true), semanticSupport: z.literal("unreviewed") })).max(SENTINEL_LIMITS.pageRows),
  hasMore: z.boolean(), nextAfterSequence: z.number().int().positive().safe().nullable(),
});

async function claimRpc(name: string, parameters: Record<string, unknown>) {
  try {
    const db = getSupabaseAdminClient() as SupabaseClient | null;
    if (!db) throw new SentinelRunError("STORAGE_UNAVAILABLE");
    const { data, error } = await db.rpc(name, parameters);
    if (error) throw new SentinelRunError(error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID"
      : ["40001", "23505"].includes(error.code) ? "RUN_CONFLICT" : "STORAGE_UNAVAILABLE");
    return data;
  } catch (error) {
    if (error instanceof SentinelRunError) throw error;
    throw new SentinelRunError("STORAGE_UNAVAILABLE");
  }
}

/** Private worker publication. Citation integrity never closes the human-review fence. */
export async function publishClaims(input: unknown) {
  const parsed = ClaimPublicationSchema.safeParse(input);
  if (!parsed.success) throw new SentinelRunError("INPUT_INVALID");
  const c = parsed.data;
  try {
    const result = ClaimPublicationResultSchema.parse(await claimRpc("sentinel_publish_claims", {
      p_organization_id: c.scope.organizationId, p_incident_id: c.scope.incidentId, p_mode: c.scope.mode,
      p_run_id: c.runId, p_owner: c.owner, p_fence: c.fence, p_command_id: c.commandId,
      p_expected_generation: c.expectedEvidenceGeneration, p_version_ids: c.versionIds, p_claims: c.claims, p_transient_texts: c.transientTexts,
    }));
    const r = result.receipt;
    assertEvidenceScope(r.scope, c.scope);
    if (r.commandId !== c.commandId || r.runId !== c.runId || (r.reopenedMarkers !== undefined && c.claims.length === 0) ||
        r.evidenceGeneration !== c.expectedEvidenceGeneration + (r.reopenedMarkers ? 1 : 0) ||
        r.fence > c.fence || (!result.replayed && r.fence !== c.fence) ||
        JSON.stringify(r.versionIds) !== JSON.stringify(c.versionIds) || JSON.stringify(r.claimIds) !== JSON.stringify(c.claims.map(item => item.id))) {
      throw new SentinelRunError("STORAGE_UNAVAILABLE");
    }
    return result;
  } catch (error) {
    if (error instanceof SentinelRunError) throw error;
    throw new SentinelRunError("STORAGE_UNAVAILABLE");
  }
}

/** Private member projection; caller-supplied positions do not confer authority. */
export async function readClaimPage(incidentId: string, mode: string, versionId: string, afterSequence = 0) {
  const parsed = z.strictObject({ incidentId: canonicalId, mode: ModeSchema, versionId: canonicalId,
    afterSequence: z.number().int().nonnegative().safe() }).safeParse({ incidentId, mode, versionId, afterSequence });
  if (!parsed.success) throw new SentinelRunError("INPUT_INVALID");
  try {
    const user = await getCurrentUser();
    if (!user) throw new SentinelRunError("AUTH_REQUIRED");
    if (!user.organizationId || !user.role || !["viewer", "analyst", "incident_commander"].includes(user.role)) throw new SentinelRunError("SCOPE_DENIED");
    const scope = { organizationId: user.organizationId, incidentId: parsed.data.incidentId, mode: parsed.data.mode };
    const data = await claimRpc("sentinel_read_claims", { p_actor_id: user.id, p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_version_id: parsed.data.versionId, p_after_sequence: afterSequence });
    if (data === null) return null;
    if (utf8Bytes(JSON.stringify(data)) > SENTINEL_LIMITS.providerResponseBytes) throw new SentinelRunError("STORAGE_UNAVAILABLE");
    const page = ClaimPageSchema.parse(data);
    assertEvidenceScope(page.scope, scope);
    let previous = afterSequence;
    const ids = new Set<string>();
    if (page.versionId !== parsed.data.versionId) throw new SentinelRunError("STORAGE_UNAVAILABLE");
    for (const item of page.items) {
      assertEvidenceScope(item.claim.scope, scope);
      if (item.sequence <= previous || item.claim.documentVersionId !== page.versionId || ids.has(item.claim.id) ||
          evidenceHash(item.claim.excerpt) !== item.claim.excerptHash || utf8Bytes(item.claim.excerpt) !== item.claim.excerptEnd - item.claim.excerptStart) {
        throw new SentinelRunError("STORAGE_UNAVAILABLE");
      }
      previous = item.sequence; ids.add(item.claim.id);
    }
    if (page.hasMore !== (page.nextAfterSequence !== null) || (page.hasMore &&
        (page.items.length === 0 || page.nextAfterSequence !== previous))) throw new SentinelRunError("STORAGE_UNAVAILABLE");
    return page;
  } catch (error) {
    if (error instanceof SentinelRunError) throw error;
    throw new SentinelRunError("STORAGE_UNAVAILABLE");
  }
}
