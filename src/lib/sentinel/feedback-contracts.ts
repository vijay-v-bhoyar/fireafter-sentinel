import { z } from "zod";
import { CorrectionTextSchema, HashSchema, IdSchema, InstantSchema, ScopeSchema } from "./contracts";
const id = IdSchema.transform(v => v.toLowerCase());
const correction = CorrectionTextSchema.refine(v => v.trim().length > 0 && !v.includes("\0") &&
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(v)) === v);
const reason = z.enum(["identity_error", "time_error", "unsupported_claim", "constraint_error", "not_material", "other"]);
export const FeedbackInputSchema = z.strictObject({
  schemaVersion: z.literal(1), claimId: id, originalClaimHash: HashSchema,
  correctedClaimText: correction.nullable(), correctedClaimId: id.nullable(), reasonCode: reason,
  permissionRecordId: id.nullable(),
}).refine(v => (v.correctedClaimText !== null) !== (v.correctedClaimId !== null) && v.correctedClaimId !== v.claimId);
export const FeedbackObservationSchema = z.strictObject({
  id: IdSchema, scope: ScopeSchema, claimId: IdSchema, documentVersionId: IdSchema, runId: IdSchema,
  modelVersion: z.string().min(1).max(200), promptVersion: z.string().min(1).max(200), policyRevisionId: IdSchema.nullable(),
  originalClaimHash: HashSchema, correctedClaimText: correction.nullable(), correctedClaimId: IdSchema.nullable(), reasonCode: reason,
  reviewKind: z.enum(["claim", "plan"]), claimReviewId: IdSchema.nullable(), reviewDecisionId: IdSchema.nullable(),
  receiptId: IdSchema, actorId: IdSchema, createdAt: InstantSchema, permissionRecordId: IdSchema.nullable(),
}).refine(v => (v.correctedClaimText !== null) !== (v.correctedClaimId !== null) && v.correctedClaimId !== v.claimId &&
  (v.reviewKind === "claim" ? v.claimReviewId !== null && v.reviewDecisionId === null : v.reviewDecisionId !== null && v.claimReviewId === null));
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;
export type FeedbackObservation = z.infer<typeof FeedbackObservationSchema>;
/** Receipt linkage is checked independently of storage; optional learning grants never authorize review. */
export function feedbackMatches(f: FeedbackObservation | undefined, context: {
  scope: z.infer<typeof ScopeSchema>; actorId: string; receiptId: string; reviewId: string; kind: "claim" | "plan";
  claimId?: string; input?: FeedbackInput;
}) {
  if (!f) return context.input === undefined;
  if (f.scope.organizationId !== context.scope.organizationId || f.scope.incidentId !== context.scope.incidentId ||
    f.scope.mode !== context.scope.mode || f.actorId !== context.actorId || f.receiptId !== context.receiptId ||
    f.reviewKind !== context.kind || (context.kind === "claim" ? f.claimReviewId : f.reviewDecisionId) !== context.reviewId ||
    (context.claimId !== undefined && f.claimId !== context.claimId)) return false;
  return !context.input || (["claimId", "originalClaimHash", "correctedClaimText", "correctedClaimId", "reasonCode", "permissionRecordId"] as const)
    .every(k => f[k] === context.input![k]);
}
