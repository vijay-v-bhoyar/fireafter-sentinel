import "server-only";
import { createHash } from "node:crypto";
import {
  ClaimSchema, ClaimReviewSchema, DocumentObservationSchema, DocumentVersionSchema, IdSchema, InstantSchema,
  ScopeSchema, SENTINEL_LIMITS, SentinelEvidenceError, type SentinelScope, type DocumentVersion,
} from "./contracts";

export function evidenceHash(text: string) { return createHash("sha256").update(text, "utf8").digest("hex"); }

function versionIdentity(value: Pick<DocumentVersion, "scope" | "documentId" | "sourceConfigRevision" | "normalizedHash" |
  "issuer" | "jurisdiction" | "canonicalUrl" | "publishedAt" | "effectiveFrom" | "effectiveUntil" | "availability" | "contentPermission">) {
  const instant = (input: string | null) => input === null ? null : new Date(input).toISOString();
  return evidenceHash(JSON.stringify([
    value.scope.organizationId, value.scope.incidentId, value.scope.mode,
    value.documentId, value.sourceConfigRevision, "sentinel-text-v1", value.normalizedHash,
    value.issuer, value.jurisdiction, value.canonicalUrl, instant(value.publishedAt),
    instant(value.effectiveFrom), instant(value.effectiveUntil), value.availability, value.contentPermission,
  ]));
}

export function assertEvidenceScope(actual: SentinelScope, expected: SentinelScope) {
  const a = ScopeSchema.parse(actual), b = ScopeSchema.parse(expected);
  if (a.organizationId !== b.organizationId || a.incidentId !== b.incidentId || a.mode !== b.mode) {
    throw new SentinelEvidenceError("SCOPE_DENIED");
  }
}

/** Preserve meaningful whitespace; v1 only normalizes BOM, line endings and Unicode NFC. */
export function normalizeEvidenceText(text: string) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").normalize("NFC");
}

/** Caller supplies server identity/time; this routine does not authorize or persist a version. */
export function prepareDocumentVersion(input: unknown, stamp: { id: string; retrievedAt: string }) {
  const observation = DocumentObservationSchema.parse(input);
  const normalizedText = normalizeEvidenceText(observation.rawText);
  const normalizedBytes = Buffer.byteLength(normalizedText, "utf8");
  if (normalizedBytes > SENTINEL_LIMITS.sourceBytes) throw new SentinelEvidenceError("INPUT_INVALID");
  const normalizedHash = evidenceHash(normalizedText);
  // Retrieval time is deliberately absent: rechecking a notice does not republish it.
  const identityHash = versionIdentity({ ...observation, normalizedHash });
  const { rawText, ...metadata } = observation;
  const version = DocumentVersionSchema.parse({
    ...metadata, id: IdSchema.parse(stamp.id), retrievedAt: InstantSchema.parse(stamp.retrievedAt),
    schemaVersion: 1, normalizationVersion: "sentinel-text-v1", identityHash,
    rawHash: evidenceHash(rawText), normalizedHash, normalizedBytes,
    normalizedText: observation.contentPermission === "full_text" ? normalizedText : null,
  });
  return { version, transientNormalizedText: normalizedText };
}

export function assertVersionIntegrity(input: unknown): DocumentVersion {
  const version = DocumentVersionSchema.parse(input);
  if (version.identityHash !== versionIdentity(version) ||
      (version.normalizedText !== null && evidenceHash(version.normalizedText) !== version.normalizedHash)) {
    throw new SentinelEvidenceError("CLAIM_UNSUPPORTED");
  }
  return version;
}

/** Offsets are UTF-8 bytes in the normalized representation, never model token positions. */
export function validateClaimCitation(input: unknown, versionInput: unknown, expectedScope: SentinelScope, transientText?: string) {
  const claim = ClaimSchema.parse(input);
  const version = assertVersionIntegrity(versionInput);
  assertEvidenceScope(version.scope, expectedScope);
  assertEvidenceScope(claim.scope, expectedScope);
  if (claim.documentVersionId !== version.id || version.availability !== "available" || version.contentPermission === "metadata_only") {
    throw new SentinelEvidenceError("CLAIM_UNSUPPORTED");
  }
  const text = version.normalizedText ?? transientText;
  if (text === undefined || text === null || evidenceHash(text) !== version.normalizedHash) {
    throw new SentinelEvidenceError("CLAIM_UNSUPPORTED");
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength !== version.normalizedBytes || claim.excerptEnd > bytes.byteLength) throw new SentinelEvidenceError("CLAIM_UNSUPPORTED");
  const selected = bytes.subarray(claim.excerptStart, claim.excerptEnd);
  const excerpt = selected.toString("utf8");
  if (!Buffer.from(excerpt, "utf8").equals(selected) || excerpt !== claim.excerpt || evidenceHash(excerpt) !== claim.excerptHash) {
    throw new SentinelEvidenceError("CLAIM_UNSUPPORTED");
  }
  // A matching quote proves integrity only. Semantic support/applicability require a separate review.
  return { claim, citationVerified: true as const, semanticSupport: "unreviewed" as const };
}

export function claimReviewAllowsDependency(reviewInput: unknown, claimInput: unknown, scope: SentinelScope) {
  const review = ClaimReviewSchema.parse(reviewInput), claim = ClaimSchema.parse(claimInput);
  assertEvidenceScope(review.scope, scope); assertEvidenceScope(claim.scope, scope);
  return review.claimId === claim.id && review.support === "supported" && review.applicability === "applicable" &&
    review.provenance === "verified" && review.conflict === "clear";
}

/** This is a projection at a supplied trusted clock, not decision-commit authorization. */
export function evidenceTemporalStatus(versionInput: unknown, input: { now: string; expiresAt: string; scope: SentinelScope }) {
  const version = assertVersionIntegrity(versionInput);
  const now = Date.parse(InstantSchema.parse(input.now)), expiry = Date.parse(InstantSchema.parse(input.expiresAt));
  assertEvidenceScope(version.scope, input.scope);
  if (Date.parse(version.retrievedAt) > now || (version.publishedAt && Date.parse(version.publishedAt) > now)) return "future" as const;
  if (version.availability !== "available") return version.availability;
  if (version.effectiveFrom && Date.parse(version.effectiveFrom) > now) return "future" as const;
  if (expiry <= now || (version.effectiveUntil && Date.parse(version.effectiveUntil) <= now)) return "expired" as const;
  if (!version.publishedAt || !version.effectiveFrom) return "unknown" as const;
  return "current" as const;
}
