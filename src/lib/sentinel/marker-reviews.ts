import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { AvailabilitySchema, ContentPermissionSchema, HashSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS, utf8Bytes } from "./contracts";
import { assertEvidenceScope } from "./evidence";

const id = IdSchema.transform(value => value.toLowerCase());
const generation = z.number().int().nonnegative().safe();
const materiality = z.enum(["material", "benign", "unresolved"]);
const note = z.string().min(1).max(2000).refine(value => value === value.trim() && utf8Bytes(value) <= 8000 && !value.includes("\0") &&
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value);
export const MarkerReviewBodySchema = z.strictObject({
  incidentId: id, mode: ModeSchema, commandId: id, expectedEvidenceGeneration: generation.max(Number.MAX_SAFE_INTEGER - 1),
  expectedReviewId: id.nullable(), expectedReviewVectorHash: HashSchema, changeId: id.nullable(),
  action: z.enum(["resolve", "hold"]), materiality, completeReview: z.boolean(), provenance: z.enum(["verified", "unresolved"]), note,
}).superRefine((value, ctx) => {
  if (value.action === "resolve" && (!value.changeId || !value.completeReview || value.provenance !== "verified" || value.materiality === "unresolved"))
    ctx.addIssue({ code: "custom", message: "A resolved source needs a complete, verified human judgment." });
});
const commandSchema = MarkerReviewBodySchema.safeExtend({ markerId: id });
export const MarkerReviewSchema = z.strictObject({ id: IdSchema, scope: ScopeSchema, markerId: IdSchema, changeId: IdSchema.nullable(),
  actorId: IdSchema, receiptId: IdSchema, createdAt: InstantSchema, action: z.enum(["resolve", "hold"]), materiality,
  completeReview: z.boolean(), provenance: z.enum(["verified", "unresolved"]), note, reviewVectorHash: HashSchema })
  .refine(value => value.action !== "resolve" || (value.changeId !== null && value.completeReview && value.provenance === "verified" && value.materiality !== "unresolved"));
const receiptSchema = z.strictObject({ id: IdSchema, scope: ScopeSchema, markerId: IdSchema, changeId: IdSchema.nullable(), reviewId: IdSchema,
  actorId: IdSchema, commandId: IdSchema, previousReviewId: IdSchema.nullable(), committedAt: InstantSchema, evidenceGeneration: generation,
  unresolvedSourceChanges: generation, markerResolved: z.boolean(), reviewVectorHash: HashSchema });
const resultSchema = z.strictObject({ review: MarkerReviewSchema, receipt: receiptSchema, replayed: z.boolean() });
const previewSchema = z.strictObject({ scope: ScopeSchema, markerId: IdSchema, documentId: IdSchema,
  versionIds: z.array(IdSchema).min(1).max(2), versions: z.array(z.strictObject({ id: IdSchema, normalizedHash: HashSchema,
    contentPermission: ContentPermissionSchema, availability: AvailabilitySchema })).min(1).max(2),
  evidenceGeneration: generation, unresolvedSourceChanges: generation, reviewVectorHash: HashSchema, unresolvedClaimReviews: generation,
  supportedCurrentClaims: generation, resolutionIssues: z.array(z.enum(["source_not_current", "source_unavailable", "retained_full_text_required", "authority_conflict",
    "extraction_not_recorded", "unresolved_claim_reviews", "review_vector_too_large", "comparison_missing", "entity_candidates_changed"])).max(11),
  latestChangeId: IdSchema.nullable(), latestReviewId: IdSchema.nullable(), resolved: z.boolean(),
  reason: z.enum(["human_resolve", "human_hold", "claim_changed", "claim_review_changed", "draft_changed"]).nullable(),
  review: MarkerReviewSchema.nullable(), receipt: receiptSchema.nullable(), observedAt: InstantSchema });
const messages = { AUTH_REQUIRED: "Sign in to review this source change.", SCOPE_DENIED: "This source change is unavailable in your workspace.",
  INPUT_INVALID: "Source review input is invalid or exceeds the supported bounds.", REVIEW_CONFLICT: "The source, comparison or review changed, or remains unresolved. Read its current state.",
  STORAGE_UNAVAILABLE: "Source review storage is unavailable. Try again later." };
export class SentinelMarkerReviewError extends Error {
  constructor(readonly code: keyof typeof messages) { super(messages[code]); this.name = "SentinelMarkerReviewError"; }
}
async function actor(write: boolean) {
  const user = await getCurrentUser();
  if (!user) throw new SentinelMarkerReviewError("AUTH_REQUIRED");
  if (!user.organizationId || !user.role || !(write ? ["analyst", "incident_commander"] : ["viewer", "analyst", "incident_commander"]).includes(user.role))
    throw new SentinelMarkerReviewError("SCOPE_DENIED");
  IdSchema.parse(user.id); IdSchema.parse(user.organizationId);
  return { id: user.id.toLowerCase(), organizationId: user.organizationId.toLowerCase() };
}
async function rpc(name: string, params: Record<string, unknown>) {
  const db = getSupabaseAdminClient() as SupabaseClient | null;
  if (!db) throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE");
  const { data, error } = await db.rpc(name, params);
  if (error) throw new SentinelMarkerReviewError(error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID"
    : ["40001", "23505"].includes(error.code) ? "REVIEW_CONFLICT" : "STORAGE_UNAVAILABLE");
  return data;
}
function bind(review: z.infer<typeof MarkerReviewSchema>, receipt: z.infer<typeof receiptSchema>, scope: z.infer<typeof ScopeSchema>, markerId: string) {
  assertEvidenceScope(review.scope, scope); assertEvidenceScope(receipt.scope, scope);
  if (review.markerId !== markerId || receipt.markerId !== markerId || review.id !== receipt.reviewId || review.receiptId !== receipt.id ||
      review.actorId !== receipt.actorId || review.changeId !== receipt.changeId || review.createdAt !== receipt.committedAt ||
      review.reviewVectorHash !== receipt.reviewVectorHash || receipt.markerResolved !== (review.action === "resolve") || receipt.evidenceGeneration === 0)
    throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE");
}
/** The human attests a complete source review; this never approves a plan or physical action. */
export async function recordMarkerReview(input: unknown) {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success || utf8Bytes(JSON.stringify(parsed.data)) > SENTINEL_LIMITS.mutationBytes) throw new SentinelMarkerReviewError("INPUT_INVALID");
  const c = parsed.data;
  try {
    const user = await actor(true), scope = { organizationId: user.organizationId, incidentId: c.incidentId, mode: c.mode };
    const payload = { expectedEvidenceGeneration: c.expectedEvidenceGeneration, expectedReviewId: c.expectedReviewId, expectedReviewVectorHash: c.expectedReviewVectorHash,
      changeId: c.changeId, action: c.action, materiality: c.materiality, completeReview: c.completeReview, provenance: c.provenance, note: c.note };
    const result = resultSchema.parse(await rpc("sentinel_record_marker_review", { p_actor_id: user.id, p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_marker_id: c.markerId, p_command_id: c.commandId, p_review: payload }));
    bind(result.review, result.receipt, scope, c.markerId);
    if (result.receipt.actorId !== user.id || result.receipt.commandId !== c.commandId || result.receipt.previousReviewId !== c.expectedReviewId ||
        result.receipt.evidenceGeneration !== c.expectedEvidenceGeneration + 1 || result.receipt.reviewVectorHash !== c.expectedReviewVectorHash || result.review.changeId !== c.changeId ||
        (["action", "materiality", "completeReview", "provenance", "note"] as const).some(key => result.review[key] !== c[key])) throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE");
    return result;
  } catch (error) { if (error instanceof SentinelMarkerReviewError) throw error; throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE"); }
}
export async function readMarkerReview(incidentId: string, mode: string, markerId: string) {
  const parsed = z.strictObject({ incidentId: id, mode: ModeSchema, markerId: id }).safeParse({ incidentId, mode, markerId });
  if (!parsed.success) throw new SentinelMarkerReviewError("INPUT_INVALID");
  try {
    const user = await actor(false), scope = { organizationId: user.organizationId, incidentId: parsed.data.incidentId, mode: parsed.data.mode };
    const data = await rpc("sentinel_read_marker_review", { p_actor_id: user.id, p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_marker_id: parsed.data.markerId });
    if (data === null) return null;
    if (utf8Bytes(JSON.stringify(data)) > SENTINEL_LIMITS.providerResponseBytes) throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE");
    const result = previewSchema.parse(data); assertEvidenceScope(result.scope, scope);
    if (result.markerId !== parsed.data.markerId || new Set(result.versionIds).size !== result.versionIds.length ||
        result.versions.length !== result.versionIds.length || new Set(result.versions.map(v => v.id)).size !== result.versions.length ||
        result.versions.some(v => !result.versionIds.includes(v.id)) || (result.review === null) !== (result.receipt === null) ||
        result.latestReviewId !== (result.review?.id ?? null)) throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE");
    if (result.review && result.receipt) {
      bind(result.review, result.receipt, scope, parsed.data.markerId);
      if (result.receipt.evidenceGeneration > result.evidenceGeneration || (result.resolved && (result.review.action !== "resolve" || result.latestChangeId !== result.review.changeId)))
        throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE");
    } else if (result.resolved || result.reason !== null) throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE");
    return result;
  } catch (error) { if (error instanceof SentinelMarkerReviewError) throw error; throw new SentinelMarkerReviewError("STORAGE_UNAVAILABLE"); }
}
