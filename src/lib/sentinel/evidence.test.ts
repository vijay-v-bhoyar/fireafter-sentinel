import { describe, expect, it } from "vitest";
import { ClaimReviewSchema, DecisionCommandSchema, DocumentObservationSchema, FeedbackSchema, SENTINEL_LIMITS } from "./contracts";
import { assertVersionIntegrity, claimReviewAllowsDependency, evidenceHash, evidenceTemporalStatus, prepareDocumentVersion, validateClaimCitation } from "./evidence";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const observed = {
  scope, documentId: id(3), sourceConfigRevision: id(4), issuer: "Synthetic county public works",
  jurisdiction: "Fixture county", canonicalUrl: "https://example.gov/notices/access",
  rawText: "Gate A opens at 12:00 UTC.\nCafé inspection required.",
  publishedAt: "2026-10-11T06:00:00Z", effectiveFrom: "2026-10-11T08:00:00Z", effectiveUntil: "2026-10-11T16:00:00Z",
  availability: "available" as const, contentPermission: "full_text" as const,
};
const stamp = { id: id(5), retrievedAt: "2026-10-11T09:00:00Z" };
function claim(text = observed.rawText.split("\n")[0]) {
  return {
    id: id(6), scope, documentVersionId: stamp.id, runId: id(7), excerptStart: 0,
    excerptEnd: Buffer.byteLength(text), excerpt: text, excerptHash: evidenceHash(text),
    kind: "access_window", claimText: "Gate A permits access from 12:00 UTC.", entityIds: [id(8)],
    modelVersion: "fixture-no-provider", promptVersion: "fixture-v1", createdAt: stamp.retrievedAt,
  };
}
const review = {
  id: id(9), scope, claimId: id(6), actorId: id(10), receiptId: id(11), createdAt: stamp.retrievedAt,
  support: "supported", applicability: "applicable", provenance: "verified", conflict: "clear", note: "Synthetic test review",
};

describe("Sentinel immutable evidence and citation contract", () => {
  it("rechecks without republishing or inventing a missing publication date", () => {
    const old = prepareDocumentVersion({ ...observed, publishedAt: null }, stamp);
    const fresh = prepareDocumentVersion({ ...observed, publishedAt: null }, { id: id(12), retrievedAt: "2026-10-11T10:00:00Z" });
    expect(fresh.version.identityHash).toBe(old.version.identityHash);
    expect(fresh.version.publishedAt).toBeNull();
    expect(old.version.retrievedAt).toBe(stamp.retrievedAt);
  });
  it("normalizes representation without collapsing meaningful whitespace", () => {
    const a = prepareDocumentVersion({ ...observed, rawText: "\uFEFFCafe\u0301\r\n  A" }, stamp);
    const b = prepareDocumentVersion({ ...observed, rawText: "Café\n  A" }, stamp);
    expect(a.version.rawHash).not.toBe(b.version.rawHash);
    expect(a.version.normalizedText).toBe("Café\n  A");
    expect(a.version.identityHash).toBe(b.version.identityHash);
    expect(prepareDocumentVersion({ ...observed, rawText: "Café\n A" }, stamp).version.identityHash).not.toBe(b.version.identityHash);
  });
  it.each([
    { issuer: "Different issuer" }, { jurisdiction: "Different county" }, { canonicalUrl: "https://example.gov/notices/other" },
    { sourceConfigRevision: id(16) }, { effectiveFrom: "2026-10-11T12:00:00Z" }, { publishedAt: null },
    { availability: "withdrawn" }, { contentPermission: "excerpt_only" }, { rawText: "Gate A is closed." },
    { scope: { ...scope, mode: "live" } },
  ])("a meaning/provenance/mode change creates a distinct identity: %j", patch => {
    const old = prepareDocumentVersion(observed, stamp).version;
    expect(prepareDocumentVersion({ ...observed, ...patch }, stamp).version.identityHash).not.toBe(old.identityHash);
    expect(old.effectiveFrom).toBe(observed.effectiveFrom);
  });
  it("retains no full text when storage permission is limited", () => {
    const prepared = prepareDocumentVersion({ ...observed, contentPermission: "excerpt_only" }, stamp);
    expect(prepared.version.normalizedText).toBeNull();
    expect(() => validateClaimCitation(claim(), prepared.version, scope)).toThrow();
    expect(validateClaimCitation(claim(), prepared.version, scope, prepared.transientNormalizedText).semanticSupport).toBe("unreviewed");
    const metadata = prepareDocumentVersion({ ...observed, contentPermission: "metadata_only" }, stamp);
    expect(() => validateClaimCitation(claim(), metadata.version, scope, metadata.transientNormalizedText)).toThrow();
  });
  it.each(["actorId", "role", "retrievedAt", "id"])("rejects caller-supplied privileged field %s", key => {
    expect(DocumentObservationSchema.safeParse({ ...observed, [key]: id(20) }).success).toBe(false);
  });
  it.each(["http://example.gov/notice", "https://localhost/notice", "https://example.local/notice", "https://127.0.0.1/notice", "https://user:pass@example.gov/notice", "https://example.gov/notice#fragment"])("rejects unqualified source URL %s", canonicalUrl => {
    expect(DocumentObservationSchema.safeParse({ ...observed, canonicalUrl }).success).toBe(false);
  });
  it("rejects byte overflow, malformed Unicode and reversed/invalid dates", () => {
    expect(() => prepareDocumentVersion({ ...observed, rawText: "é".repeat(SENTINEL_LIMITS.sourceBytes / 2 + 1) }, stamp)).toThrow();
    expect(() => prepareDocumentVersion({ ...observed, rawText: "\ud800" }, stamp)).toThrow();
    expect(() => prepareDocumentVersion({ ...observed, effectiveUntil: observed.effectiveFrom }, stamp)).toThrow();
    expect(() => prepareDocumentVersion({ ...observed, publishedAt: "2026-04-31T09:00:00Z" }, stamp)).toThrow();
    expect(() => prepareDocumentVersion({ ...observed, rawText: "Text\0text" }, stamp)).toThrow();
    expect(() => prepareDocumentVersion({ ...observed, publishedAt: "2026-10-11T06:00:00.000001Z" }, stamp)).toThrow();
  });
  it("binds equivalent UTC representations to the same database-readable identity", () => {
    const original = prepareDocumentVersion(observed, stamp).version;
    expect(assertVersionIntegrity({ ...original, publishedAt: new Date(observed.publishedAt).toISOString(), effectiveFrom: new Date(observed.effectiveFrom).toISOString() }).identityHash).toBe(original.identityHash);
  });
  it("verifies an exact citation without promoting semantic support", () => {
    const result = validateClaimCitation(claim(), prepareDocumentVersion(observed, stamp).version, scope);
    expect(result.citationVerified).toBe(true); expect(result.semanticSupport).toBe("unreviewed");
    expect(claimReviewAllowsDependency(review, claim(), scope)).toBe(true);
  });
  it.each([
    { excerpt: "Gate A is safe." }, { excerptHash: "a".repeat(64) }, { excerptEnd: 9999 }, { documentVersionId: id(90) },
    { scope: { ...scope, incidentId: id(90) } }, { scope: { ...scope, organizationId: id(90) } }, { scope: { ...scope, mode: "live" } },
  ])("rejects forged/misbound citation %j", patch => {
    expect(() => validateClaimCitation({ ...claim(), ...patch }, prepareDocumentVersion(observed, stamp).version, scope)).toThrow();
  });
  it("rejects a byte interval that splits a Unicode character", () => {
    const prepared = prepareDocumentVersion({ ...observed, rawText: "éclair" }, stamp);
    expect(() => validateClaimCitation({ ...claim("�"), excerptEnd: 1 }, prepared.version, scope)).toThrow();
    expect(validateClaimCitation(claim("éclair"), prepared.version, scope).citationVerified).toBe(true);
  });
  it("rejects metadata and text tampering even with a superficially valid hash string", () => {
    const version = prepareDocumentVersion(observed, stamp).version;
    expect(() => assertVersionIntegrity({ ...version, issuer: "Forged" })).toThrow();
    expect(() => assertVersionIntegrity({ ...version, normalizedText: "x".repeat(version.normalizedBytes) })).toThrow();
  });
  it.each([
    { support: "unresolved" }, { support: "unsupported" }, { applicability: "unresolved" }, { applicability: "not_applicable" },
    { provenance: "unresolved" }, { conflict: "unresolved" }, { claimId: id(90) },
  ])("review cannot support a dependency while unresolved/mismatched: %j", patch => {
    expect(claimReviewAllowsDependency({ ...review, ...patch }, claim(), scope)).toBe(false);
  });
  it("rejects cross-scope reviews and role injection", () => {
    expect(() => claimReviewAllowsDependency({ ...review, scope: { ...scope, mode: "live" } }, claim(), scope)).toThrow();
    expect(ClaimReviewSchema.safeParse({ ...review, role: "incident_commander" }).success).toBe(false);
  });
  it.each([
    ["2026-10-11T07:00:00Z", "future"], ["2026-10-11T09:30:00Z", "current"], ["2026-10-11T16:00:00Z", "expired"],
  ])("projects temporal validity at %s as %s", (now, expected) => {
    expect(evidenceTemporalStatus(prepareDocumentVersion(observed, stamp).version, { now, expiresAt: observed.effectiveUntil, scope })).toBe(expected);
  });
  it("does not mistake freshly retrieved undated or withdrawn text for current authority", () => {
    const input = { now: "2026-10-11T09:30:00Z", expiresAt: observed.effectiveUntil, scope };
    expect(evidenceTemporalStatus(prepareDocumentVersion({ ...observed, publishedAt: null }, stamp).version, input)).toBe("unknown");
    expect(evidenceTemporalStatus(prepareDocumentVersion({ ...observed, availability: "withdrawn", rawText: "" }, stamp).version, input)).toBe("withdrawn");
  });
});

describe("Sentinel command and private correction admission", () => {
  const command = {
    commandId: id(1), expectedPlanRevision: id(2), expectedEvidenceGeneration: 1, expectedEvidenceVectorHash: "a".repeat(64),
    expectedConstraintRevision: id(3), expectedPolicyRevision: id(4), action: "accept",
  };
  it("refuses body-derived role/actor and ambiguous modifications", () => {
    expect(DecisionCommandSchema.safeParse({ ...command, actorId: id(5) }).success).toBe(false);
    expect(DecisionCommandSchema.safeParse({ ...command, role: "incident_commander" }).success).toBe(false);
    expect(DecisionCommandSchema.safeParse({ ...command, modifications: [] }).success).toBe(false);
    expect(DecisionCommandSchema.safeParse({ ...command, action: "modify", note: "" }).success).toBe(false);
    expect(DecisionCommandSchema.safeParse({ ...command, action: "modify", note: "Move within access window", modifications: [{ taskId: id(5), crewId: id(6), startsAt: observed.effectiveFrom }] }).success).toBe(true);
  });
  it("bounds feedback by UTF-8 bytes and requires one correction representation", () => {
    const correction = { claimId: id(1), documentVersionId: id(2), originalClaimHash: "a".repeat(64), reasonCode: "unsupported_claim", correctedClaimText: "é".repeat(1024) };
    expect(FeedbackSchema.safeParse(correction).success).toBe(true);
    expect(FeedbackSchema.safeParse({ ...correction, correctedClaimText: correction.correctedClaimText + "é" }).success).toBe(false);
    expect(FeedbackSchema.safeParse({ ...correction, correctedClaimId: id(3) }).success).toBe(false);
    expect(FeedbackSchema.safeParse({ ...correction, correctedClaimText: undefined }).success).toBe(false);
  });
});
