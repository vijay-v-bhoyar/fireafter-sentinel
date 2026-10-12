import { z } from "zod";

export const SENTINEL_LIMITS = {
  documents: 5, sourceBytes: 100 * 1024, aggregateSourceBytes: 500 * 1024,
  mutationBytes: 128 * 1024, briefingBytes: 2 * 1024 * 1024, pageRows: 25,
  tasks: 10, crews: 2, shiftMinutes: 8 * 60, feedbackBytes: 2 * 1024,
  runMs: 120_000, providerResponseBytes: 1024 * 1024,
  tavilyRequests: 4, modelRequests: 8, inputTokens: 24_000, outputTokens: 6_000,
  outputTokensPerRequest: 1_000,
} as const;

export const IdSchema = z.uuid();
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ModeSchema = z.enum(["live", "replay", "synthetic"]);
export const RoleSchema = z.enum(["incident_commander", "analyst", "viewer"]);
export const InstantSchema = z.iso.datetime().refine(value => {
  const parsed = new Date(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value.slice(0, 10);
}, "Use a valid UTC instant with at most millisecond precision.");
export const ScopeSchema = z.strictObject({ organizationId: IdSchema, incidentId: IdSchema, mode: ModeSchema });
export type SentinelScope = z.infer<typeof ScopeSchema>;

export function utf8Bytes(value: string) { return new TextEncoder().encode(value).byteLength; }
export const CorrectionTextSchema = z.string().min(1).max(SENTINEL_LIMITS.feedbackBytes)
  .refine(value => utf8Bytes(value) <= SENTINEL_LIMITS.feedbackBytes, "Correction exceeds the UTF-8 limit.");

export const RegisteredUrlSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return value === value.trim() && url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      (!url.port || url.port === "443") && !host.startsWith("[") && !/^\d+(?:\.\d+){3}$/.test(host) &&
      host.includes(".") && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host);
  } catch { return false; }
}, "Use a registered public HTTPS source URL.");

export const AvailabilitySchema = z.enum(["available", "withdrawn", "incomplete"]);
export const ContentPermissionSchema = z.enum(["full_text", "excerpt_only", "metadata_only"]);
export const DocumentObservationSchema = z.strictObject({
  scope: ScopeSchema, documentId: IdSchema, sourceConfigRevision: IdSchema,
  issuer: z.string().trim().min(1).max(200), jurisdiction: z.string().trim().min(1).max(200),
  canonicalUrl: RegisteredUrlSchema,
  rawText: z.string().max(SENTINEL_LIMITS.sourceBytes)
    .refine(value => utf8Bytes(value) <= SENTINEL_LIMITS.sourceBytes, "Source text exceeds the UTF-8 limit.")
    .refine(value => !value.includes("\0") && new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value, "Source text contains invalid Unicode or NUL."),
  publishedAt: InstantSchema.nullable(), effectiveFrom: InstantSchema.nullable(), effectiveUntil: InstantSchema.nullable(),
  availability: AvailabilitySchema, contentPermission: ContentPermissionSchema,
}).superRefine((value, context) => {
  if (value.availability === "available" && !value.rawText.trim()) {
    context.addIssue({ code: "custom", message: "Available text must not be empty.", path: ["rawText"] });
  }
  if (value.effectiveFrom && value.effectiveUntil && Date.parse(value.effectiveFrom) >= Date.parse(value.effectiveUntil)) {
    context.addIssue({ code: "custom", message: "Effective interval must have positive length.", path: ["effectiveUntil"] });
  }
});
export type DocumentObservation = z.infer<typeof DocumentObservationSchema>;

export const DocumentVersionSchema = z.strictObject({
  id: IdSchema, scope: ScopeSchema, documentId: IdSchema, sourceConfigRevision: IdSchema,
  schemaVersion: z.literal(1), normalizationVersion: z.literal("sentinel-text-v1"),
  identityHash: HashSchema, rawHash: HashSchema, normalizedHash: HashSchema,
  normalizedBytes: z.number().int().min(0).max(SENTINEL_LIMITS.sourceBytes),
  normalizedText: z.string().nullable(), issuer: z.string().min(1).max(200), jurisdiction: z.string().min(1).max(200),
  canonicalUrl: RegisteredUrlSchema, publishedAt: InstantSchema.nullable(), effectiveFrom: InstantSchema.nullable(),
  effectiveUntil: InstantSchema.nullable(), retrievedAt: InstantSchema, availability: AvailabilitySchema,
  contentPermission: ContentPermissionSchema,
}).superRefine((value, context) => {
  if (value.contentPermission !== "full_text" && value.normalizedText !== null) {
    context.addIssue({ code: "custom", message: "Full text cannot be retained under this permission.", path: ["normalizedText"] });
  }
  if (value.normalizedText !== null && utf8Bytes(value.normalizedText) !== value.normalizedBytes) {
    context.addIssue({ code: "custom", message: "Text length differs from its declared UTF-8 bytes.", path: ["normalizedBytes"] });
  }
});
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

export const ClaimSchema = z.strictObject({
  id: IdSchema, scope: ScopeSchema, documentVersionId: IdSchema, runId: IdSchema,
  excerptStart: z.number().int().min(0).max(SENTINEL_LIMITS.sourceBytes),
  excerptEnd: z.number().int().min(1).max(SENTINEL_LIMITS.sourceBytes),
  excerpt: z.string().min(1).max(SENTINEL_LIMITS.sourceBytes), excerptHash: HashSchema,
  kind: z.enum(["access_window", "road_status", "inspection_condition", "general_notice"]),
  claimText: z.string().trim().min(1).max(2000), entityIds: z.array(IdSchema).max(SENTINEL_LIMITS.tasks),
  modelVersion: z.string().min(1).max(200), promptVersion: z.string().min(1).max(200), createdAt: InstantSchema,
}).refine(value => value.excerptEnd > value.excerptStart, "Citation byte interval must have positive length.");
export type EvidenceClaim = z.infer<typeof ClaimSchema>;

export const ClaimReviewSchema = z.strictObject({
  id: IdSchema, scope: ScopeSchema, claimId: IdSchema, actorId: IdSchema, receiptId: IdSchema, createdAt: InstantSchema,
  support: z.enum(["supported", "unsupported", "unresolved"]),
  applicability: z.enum(["applicable", "not_applicable", "unresolved"]),
  provenance: z.enum(["verified", "unresolved"]), conflict: z.enum(["clear", "unresolved"]),
  note: z.string().max(2000),
});
export type ClaimReview = z.infer<typeof ClaimReviewSchema>;

export const FeedbackSchema = z.strictObject({
  claimId: IdSchema, documentVersionId: IdSchema, originalClaimHash: HashSchema,
  correctedClaimText: CorrectionTextSchema.optional(), correctedClaimId: IdSchema.optional(),
  reasonCode: z.enum(["identity_error", "time_error", "unsupported_claim", "constraint_error", "not_material", "other"]),
  permissionRecordId: IdSchema.optional(),
}).refine(value => Number(value.correctedClaimText !== undefined) + Number(value.correctedClaimId !== undefined) === 1,
  "Supply exactly one corrected text or corrected claim reference.");

export const RunCommandSchema = z.strictObject({
  incidentId: IdSchema, sourceConfigRevision: IdSchema, mode: ModeSchema, commandId: IdSchema,
});
export const RunStatusSchema = z.enum(["queued", "retrieving", "interpreting", "validating", "ready_for_review", "completed", "canceled", "failed", "budget_stopped"]);
export const RunLocatorSchema = z.strictObject({ incidentId: IdSchema, mode: ModeSchema, runId: IdSchema });
export const RunCancelSchema = RunLocatorSchema.extend({ commandId: IdSchema });
export const RunProjectionSchema = z.strictObject({
  id: IdSchema, scope: ScopeSchema, sourceConfigRevision: IdSchema, createdBy: IdSchema, dispatchId: IdSchema,
  createdAt: InstantSchema, deadlineAt: InstantSchema, status: RunStatusSchema,
  stage: z.string().regex(/^[a-z0-9_-]{1,80}$/), fence: z.number().int().nonnegative().safe(), leaseUntil: InstantSchema.nullable(),
  usage: z.strictObject({
    tavilyRequests: z.number().int().min(0).max(SENTINEL_LIMITS.tavilyRequests),
    modelRequests: z.number().int().min(0).max(SENTINEL_LIMITS.modelRequests),
    inputTokens: z.number().int().min(0).max(SENTINEL_LIMITS.inputTokens),
    outputTokens: z.number().int().min(0).max(SENTINEL_LIMITS.outputTokens),
  }),
}).superRefine((run, context) => {
  if (run.id !== run.dispatchId || Date.parse(run.deadlineAt) - Date.parse(run.createdAt) !== SENTINEL_LIMITS.runMs ||
      (run.leaseUntil !== null && Date.parse(run.leaseUntil) > Date.parse(run.deadlineAt))) {
    context.addIssue({ code: "custom", message: "Run identity or fixed deadline is inconsistent." });
  }
});
export type SentinelRun = z.infer<typeof RunProjectionSchema>;
export const RunReceiptSchema = z.strictObject({
  runId: IdSchema, commandId: IdSchema, kind: z.enum(["admit", "cancel"]), status: RunStatusSchema, at: InstantSchema,
});
export const RunCommandResultSchema = z.strictObject({ run: RunProjectionSchema, receipt: RunReceiptSchema, replayed: z.boolean() })
  .refine(result => result.run.id === result.receipt.runId, "Run receipt is misbound.");
export const RunLeaseSchema = z.strictObject({ run: RunProjectionSchema, owner: IdSchema })
  .refine(result => result.run.leaseUntil !== null && result.run.fence > 0 && ["retrieving", "interpreting", "validating"].includes(result.run.status), "Lease is incomplete.");
export const WorkerLeaseInputSchema = z.strictObject({ scope: ScopeSchema, runId: IdSchema, owner: IdSchema });
export const WorkerMutationSchema = WorkerLeaseInputSchema.extend({ fence: z.number().int().positive().safe() });
export const ProviderReservationSchema = WorkerMutationSchema.extend({
  attemptId: IdSchema, stage: z.string().regex(/^[a-z0-9_-]{1,80}$/), kind: z.enum(["tavily", "model"]),
  inputTokens: z.number().int().min(0).max(SENTINEL_LIMITS.inputTokens),
  outputTokens: z.number().int().min(0).max(SENTINEL_LIMITS.outputTokensPerRequest),
}).refine(value => value.kind === "model" || (value.inputTokens === 0 && value.outputTokens === 0), "Tavily reservations do not reserve model tokens.");
export const ProviderSettlementSchema = WorkerMutationSchema.extend({
  attemptId: IdSchema, state: z.enum(["completed", "uncertain"]),
  inputTokens: z.number().int().min(0).max(SENTINEL_LIMITS.inputTokens).nullable(),
  outputTokens: z.number().int().min(0).max(SENTINEL_LIMITS.outputTokensPerRequest).nullable(),
  responseBytes: z.number().int().min(0).max(SENTINEL_LIMITS.providerResponseBytes).nullable(),
}).refine(value => value.state === "completed"
  ? value.inputTokens !== null && value.outputTokens !== null && value.responseBytes !== null
  : value.inputTokens === null && value.outputTokens === null && value.responseBytes === null, "Usage completeness differs from outcome.");
export const RunCheckpointSchema = WorkerMutationSchema.extend({
  checkpointId: IdSchema, state: z.enum(["retrieving", "interpreting", "validating"]),
  stage: z.string().regex(/^[a-z0-9_-]{1,80}$/), resultHash: HashSchema,
});
export const DecisionCommandSchema = z.strictObject({
  commandId: IdSchema, expectedPlanRevision: IdSchema, expectedEvidenceGeneration: z.number().int().nonnegative().safe(),
  expectedEvidenceVectorHash: HashSchema, expectedConstraintRevision: IdSchema, expectedPolicyRevision: IdSchema,
  action: z.enum(["accept", "modify", "reject", "annotate"]), note: z.string().max(2000).default(""),
  feedback: FeedbackSchema.optional(),
  modifications: z.array(z.strictObject({ taskId: IdSchema, crewId: IdSchema, startsAt: InstantSchema }))
    .min(1).max(SENTINEL_LIMITS.tasks).optional(),
}).superRefine((value, context) => {
  if ((value.action === "modify") !== (value.modifications !== undefined) ||
      (value.action === "modify" && !value.note.trim())) {
    context.addIssue({ code: "custom", message: "Modify requires a note and task assignments; other actions cannot alter assignments." });
  }
  if (value.modifications && new Set(value.modifications.map(item => item.taskId)).size !== value.modifications.length) {
    context.addIssue({ code: "custom", message: "A task cannot be assigned twice." });
  }
});

export class SentinelEvidenceError extends Error {
  constructor(readonly code: "INPUT_INVALID" | "SCOPE_DENIED" | "CLAIM_UNSUPPORTED" | "EVIDENCE_AMBIGUOUS") {
    super(code === "SCOPE_DENIED" ? "Evidence is unavailable in this incident and data mode."
      : code === "CLAIM_UNSUPPORTED" ? "The citation cannot support this claim."
        : code === "EVIDENCE_AMBIGUOUS" ? "Evidence requires a resolved source and applicability review."
          : "Evidence input is invalid or exceeds the supported bounds.");
    this.name = "SentinelEvidenceError";
  }
}
