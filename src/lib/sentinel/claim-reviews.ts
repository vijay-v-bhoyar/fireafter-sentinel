import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCurrentUser } from "../auth";
import { getSupabaseAdminClient } from "../supabase";
import { ClaimReviewSchema, IdSchema, InstantSchema, ModeSchema, ScopeSchema, SENTINEL_LIMITS, utf8Bytes } from "./contracts";
import { assertEvidenceScope } from "./evidence";
import { FeedbackInputSchema, FeedbackObservationSchema, feedbackMatches } from "./feedback-contracts";

const id = IdSchema.transform(value => value.toLowerCase());
const generation = z.number().int().nonnegative().safe();
export const ClaimReviewBodySchema = z.strictObject({
  incidentId: id, mode: ModeSchema, commandId: id, expectedEvidenceGeneration: generation.max(Number.MAX_SAFE_INTEGER - 1),
  expectedReviewId: id.nullable(), support: ClaimReviewSchema.shape.support, applicability: ClaimReviewSchema.shape.applicability,
  provenance: ClaimReviewSchema.shape.provenance, conflict: ClaimReviewSchema.shape.conflict,
  note: ClaimReviewSchema.shape.note.default("").refine(value => utf8Bytes(value) <= 8000 && !value.includes("\0") &&
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value),
  feedback: FeedbackInputSchema.optional(),
});
export const ClaimReviewCommandSchema = ClaimReviewBodySchema.extend({ claimId: id });
export const ClaimReviewReceiptSchema = z.strictObject({
  id: IdSchema, commandId: IdSchema, claimId: IdSchema, reviewId: IdSchema, previousReviewId: IdSchema.nullable(),
  scope: ScopeSchema, actorId: IdSchema, committedAt: InstantSchema, evidenceGeneration: generation,
  unresolvedSourceChanges: generation,
});
const resultSchema = z.strictObject({ review: ClaimReviewSchema, receipt: ClaimReviewReceiptSchema, replayed: z.boolean(), feedback: FeedbackObservationSchema.optional() });
const projectionSchema = z.strictObject({ scope: ScopeSchema, claimId: IdSchema, documentVersionId: IdSchema,
  evidenceGeneration: generation, unresolvedSourceChanges: generation, currentEvidence: z.boolean(), observedAt: InstantSchema,
  review: ClaimReviewSchema.nullable(), receipt: ClaimReviewReceiptSchema.nullable(), feedback: FeedbackObservationSchema.optional() });
type ErrorCode = "AUTH_REQUIRED" | "SCOPE_DENIED" | "INPUT_INVALID" | "REVIEW_CONFLICT" | "STORAGE_UNAVAILABLE";
const messages: Record<ErrorCode, string> = {
  AUTH_REQUIRED: "Sign in to review this claim.", SCOPE_DENIED: "This claim is unavailable in your workspace.",
  INPUT_INVALID: "Claim review input is invalid or exceeds the supported bounds.",
  REVIEW_CONFLICT: "The claim, evidence or review changed. Read its current state before reviewing again.",
  STORAGE_UNAVAILABLE: "Claim review storage is unavailable. Try again later.",
};
export class SentinelClaimReviewError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); this.name = "SentinelClaimReviewError"; }
}
async function actor(write: boolean) {
  const user = await getCurrentUser();
  if (!user) throw new SentinelClaimReviewError("AUTH_REQUIRED");
  if (!user.organizationId || !user.role || !(write ? ["analyst", "incident_commander"] : ["viewer", "analyst", "incident_commander"]).includes(user.role)) {
    throw new SentinelClaimReviewError("SCOPE_DENIED");
  }
  IdSchema.parse(user.id); IdSchema.parse(user.organizationId);
  return user as typeof user & { organizationId: string };
}
async function rpc(name: string, params: Record<string, unknown>) {
  const db = getSupabaseAdminClient() as SupabaseClient | null;
  if (!db) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
  const { data, error } = await db.rpc(name, params);
  if (error) throw new SentinelClaimReviewError(error.code === "42501" ? "SCOPE_DENIED" : error.code === "22023" ? "INPUT_INVALID"
    : ["40001", "23505"].includes(error.code) ? "REVIEW_CONFLICT" : "STORAGE_UNAVAILABLE");
  return data;
}
function bind(review: z.infer<typeof ClaimReviewSchema>, receipt: z.infer<typeof ClaimReviewReceiptSchema>, scope: z.infer<typeof ScopeSchema>, claimId: string) {
  assertEvidenceScope(review.scope, scope); assertEvidenceScope(receipt.scope, scope);
  if (review.claimId !== claimId || receipt.claimId !== claimId || receipt.reviewId !== review.id || review.receiptId !== receipt.id ||
      review.actorId !== receipt.actorId || review.createdAt !== receipt.committedAt || receipt.evidenceGeneration === 0) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
}
/** Server-authenticated human judgment. This command cannot approve a plan or resolve source changes. */
export async function recordClaimReview(input: unknown) {
  const parsed = ClaimReviewCommandSchema.safeParse(input);
  if (!parsed.success || utf8Bytes(JSON.stringify(parsed.data)) > SENTINEL_LIMITS.mutationBytes) throw new SentinelClaimReviewError("INPUT_INVALID");
  const c = parsed.data;
  try {
    const user = await actor(true), scope = { organizationId: user.organizationId.toLowerCase(), incidentId: c.incidentId, mode: c.mode };
    const payload = { expectedEvidenceGeneration: c.expectedEvidenceGeneration, expectedReviewId: c.expectedReviewId,
      support: c.support, applicability: c.applicability, provenance: c.provenance, conflict: c.conflict, note: c.note,
      ...(c.feedback ? { feedback: c.feedback } : {}) };
    const result = resultSchema.parse(await rpc("sentinel_record_claim_review", { p_actor_id: user.id.toLowerCase(), p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_claim_id: c.claimId, p_command_id: c.commandId, p_review: payload }));
    bind(result.review, result.receipt, scope, c.claimId);
    if (Boolean(c.feedback) !== Boolean(result.feedback) || !feedbackMatches(result.feedback, { scope, actorId: user.id.toLowerCase(),
      receiptId: result.receipt.id, reviewId: result.review.id, kind: "claim", claimId: c.claimId, input: c.feedback })) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
    if (result.receipt.actorId !== user.id.toLowerCase() || result.receipt.commandId !== c.commandId ||
        result.receipt.previousReviewId !== c.expectedReviewId || result.receipt.evidenceGeneration !== c.expectedEvidenceGeneration + 1 ||
        (["support", "applicability", "provenance", "conflict", "note"] as const).some(k => result.review[k] !== c[k])) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
    return result;
  } catch (error) {
    if (error instanceof SentinelClaimReviewError) throw error;
    throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
  }
}
/** Latest append-only review; currentEvidence reports source identity, not approval or temporal validity. */
export async function readClaimReview(incidentId: string, mode: string, claimId: string) {
  const parsed = z.strictObject({ incidentId: id, mode: ModeSchema, claimId: id }).safeParse({ incidentId, mode, claimId });
  if (!parsed.success) throw new SentinelClaimReviewError("INPUT_INVALID");
  try {
    const user = await actor(false), scope = { organizationId: user.organizationId.toLowerCase(), incidentId: parsed.data.incidentId, mode: parsed.data.mode };
    const data = await rpc("sentinel_read_claim_review", { p_actor_id: user.id.toLowerCase(), p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_claim_id: parsed.data.claimId });
    if (data === null) return null;
    if (utf8Bytes(JSON.stringify(data)) > SENTINEL_LIMITS.providerResponseBytes) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
    const result = projectionSchema.parse(data);
    assertEvidenceScope(result.scope, scope);
    if (result.claimId !== parsed.data.claimId || (result.review === null) !== (result.receipt === null)) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
    if (result.review && result.receipt) {
      bind(result.review, result.receipt, scope, parsed.data.claimId);
      if (!feedbackMatches(result.feedback, { scope, actorId: result.review.actorId, receiptId: result.receipt.id,
        reviewId: result.review.id, kind: "claim", claimId: parsed.data.claimId })) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
      if (result.receipt.evidenceGeneration > result.evidenceGeneration) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
    }
    if (result.feedback && (!result.review || result.feedback.documentVersionId !== result.documentVersionId)) throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
    return result;
  } catch (error) {
    if (error instanceof SentinelClaimReviewError) throw error;
    throw new SentinelClaimReviewError("STORAGE_UNAVAILABLE");
  }
}
