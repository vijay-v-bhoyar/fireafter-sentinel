import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordMarkerReview, readMarkerReview } from "./marker-reviews";
import { publishClaims } from "./claims";
import { publishChanges } from "./changes";
import { evidenceHash } from "./evidence";
const boundary = vi.hoisted(() => ({ admin: vi.fn(), rpc: vi.fn(), user: vi.fn() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
vi.mock("../auth", () => ({ getCurrentUser: () => boundary.user() }));
const id = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9);
const c = { incidentId: scope.incidentId, mode: scope.mode, markerId: id(3), commandId: id(4), expectedEvidenceGeneration: 2,
  expectedReviewId: null, expectedReviewVectorHash: "a".repeat(64), changeId: id(5), action: "resolve", materiality: "material",
  completeReview: true, provenance: "verified", note: "Synthetic whole-version review." };
const review = { id: id(6), scope, markerId: c.markerId, changeId: c.changeId, actorId: actor, receiptId: id(7), createdAt: "2026-10-11T10:00:00.000Z",
  action: c.action, materiality: c.materiality, completeReview: c.completeReview, provenance: c.provenance, note: c.note, reviewVectorHash: c.expectedReviewVectorHash };
const receipt = { id: id(7), scope, markerId: c.markerId, changeId: c.changeId, reviewId: review.id, actorId: actor, commandId: c.commandId, previousReviewId: null,
  committedAt: review.createdAt, evidenceGeneration: 3, unresolvedSourceChanges: 0, markerResolved: true, reviewVectorHash: c.expectedReviewVectorHash };
const preview = { scope, markerId: c.markerId, documentId: id(8), versionIds: [id(10)], versions: [{ id: id(10), normalizedHash: "b".repeat(64), contentPermission: "full_text", availability: "available" }],
  evidenceGeneration: 3, unresolvedSourceChanges: 0, reviewVectorHash: c.expectedReviewVectorHash, unresolvedClaimReviews: 0, supportedCurrentClaims: 1, resolutionIssues: [],
  latestChangeId: c.changeId, latestReviewId: review.id, resolved: true, reason: "human_resolve", review, receipt, observedAt: review.createdAt };
beforeEach(() => { vi.resetAllMocks(); boundary.admin.mockReturnValue({ rpc: boundary.rpc }); boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "analyst" });
  boundary.rpc.mockResolvedValue({ data: { review, receipt, replayed: false }, error: null }); });
describe("Source review command and projection boundary", () => {
  it.each([{ actorId: actor }, { organizationId: scope.organizationId }, { role: "incident_commander" }, { completeReview: false }, { provenance: "unresolved" },
    { materiality: "unresolved" }, { changeId: null }, { note: "" }, { note: "\ud800" }, { note: "\0" }, { note: "x".repeat(2001) }, { expectedEvidenceGeneration: Number.MAX_SAFE_INTEGER }])("rejects invalid or authority-owned input %j before auth/storage", async patch => {
    await expect(recordMarkerReview({ ...c, ...patch })).rejects.toMatchObject({ code: "INPUT_INVALID" }); expect(boundary.user).not.toHaveBeenCalled(); expect(boundary.admin).not.toHaveBeenCalled();
  });
  it("derives committing identity from the current session", async () => {
    expect(await recordMarkerReview(c)).toEqual({ review, receipt, replayed: false });
    expect(boundary.rpc).toHaveBeenCalledWith("sentinel_record_marker_review", { p_actor_id: actor, p_organization_id: scope.organizationId, p_incident_id: scope.incidentId,
      p_mode: scope.mode, p_marker_id: c.markerId, p_command_id: c.commandId, p_review: { expectedEvidenceGeneration: 2, expectedReviewId: null, expectedReviewVectorHash: c.expectedReviewVectorHash,
        changeId: c.changeId, action: c.action, materiality: c.materiality, completeReview: c.completeReview, provenance: c.provenance, note: c.note } });
  });
  it.each(["scope", "markerId", "changeId", "reviewId", "actorId", "commandId", "previousReviewId", "committedAt", "evidenceGeneration", "reviewVectorHash", "markerResolved"])("rejects misbound receipt %s", async key => {
    const r = structuredClone(receipt) as Record<string, unknown>;
    r[key] = key === "scope" ? { ...scope, mode: "replay" } : key === "markerResolved" ? false : key === "evidenceGeneration" ? 4 : key === "reviewVectorHash" ? "b".repeat(64) : key === "committedAt" ? "2026-10-11T11:00:00.000Z" : id(99);
    boundary.rpc.mockResolvedValue({ data: { review, receipt: r, replayed: false }, error: null }); await expect(recordMarkerReview(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it.each([["42501", "SCOPE_DENIED"], ["22023", "INPUT_INVALID"], ["40001", "REVIEW_CONFLICT"], ["23505", "REVIEW_CONFLICT"], ["XX000", "STORAGE_UNAVAILABLE"]])("maps SQL %s without leaking details", async (code, expected) => {
    boundary.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_SOURCE_DETAILS" } }); await expect(recordMarkerReview(c)).rejects.toMatchObject({ code: expected });
    try { await recordMarkerReview(c); } catch (error) { expect(String(error)).not.toContain("PRIVATE_SOURCE_DETAILS"); }
  });
  it("handles missing auth, viewer write denial and storage outages", async () => {
    boundary.user.mockResolvedValue(null); await expect(recordMarkerReview(c)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "viewer" }); await expect(recordMarkerReview(c)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    boundary.user.mockRejectedValue(new Error("PRIVATE_AUTH")); await expect(recordMarkerReview(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    boundary.admin.mockReturnValue(null); await expect(readMarkerReview(c.incidentId, c.mode, c.markerId)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("returns a bound member preview without treating history as current approval", async () => {
    boundary.rpc.mockResolvedValue({ data: { ...preview, resolved: false, reason: "claim_review_changed", evidenceGeneration: 4, unresolvedSourceChanges: 1 }, error: null });
    expect(await readMarkerReview(c.incidentId, c.mode, c.markerId)).toMatchObject({ resolved: false, review, receipt });
  });
  it.each(["scope", "marker", "version", "reviewPair", "reviewId", "generation", "approval", "invalidResolvedReview"])("rejects corrupted preview %s", async key => {
    const p = structuredClone(preview) as Record<string, unknown>;
    if (key === "scope") p.scope = { ...scope, organizationId: id(99) };
    else if (key === "marker") p.markerId = id(99);
    else if (key === "version") p.versionIds = [id(99)];
    else if (key === "reviewPair") p.review = null;
    else if (key === "reviewId") p.latestReviewId = id(99);
    else if (key === "generation") p.evidenceGeneration = 1;
    else if (key === "approval") p.planApproved = true;
    else p.review = { ...review, completeReview: false };
    boundary.rpc.mockResolvedValue({ data: p, error: null }); await expect(readMarkerReview(c.incidentId, c.mode, c.markerId)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("binds reopened publication generation and disallows impossible reopening receipts", async () => {
    const claim = { id: id(20), documentVersionId: id(10), excerptStart: 0, excerptEnd: 6, excerpt: "Notice", excerptHash: evidenceHash("Notice"), kind: "general_notice",
      claimText: "Synthetic notice", entityIds: [], modelVersion: "synthetic", promptVersion: "synthetic" };
    const command = { scope, runId: id(21), owner: id(22), fence: 1, commandId: id(23), expectedEvidenceGeneration: 3, versionIds: [id(10)], claims: [claim] };
    const r = { scope, runId: id(21), commandId: id(23), fence: 1, committedAt: review.createdAt, evidenceGeneration: 4, unresolvedSourceChanges: 2,
      reopenedMarkers: 2, versionIds: [id(10)], claimIds: [id(20)], semanticSupport: "unreviewed" };
    boundary.rpc.mockResolvedValue({ data: { receipt: r, replayed: false }, error: null }); expect((await publishClaims(command)).receipt.evidenceGeneration).toBe(4);
    boundary.rpc.mockResolvedValue({ data: { receipt: { ...r, claimIds: [] }, replayed: false }, error: null }); await expect(publishClaims({ ...command, claims: [] })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    const draft = { id: id(30), markerId: id(3), category: "addition", materiality: "material", claimIds: [id(20)], affectedEntityIds: [], explanation: "Synthetic draft", modelVersion: "synthetic", promptVersion: "synthetic" };
    const publication = { scope, runId: id(21), owner: id(22), fence: 1, commandId: id(23), expectedEvidenceGeneration: 3, changes: [draft] };
    const result = { scope, runId: id(21), commandId: id(23), fence: 1, committedAt: review.createdAt, evidenceGeneration: 4, unresolvedSourceChanges: 1,
      changeIds: [id(30)], markerIds: [id(3)], semanticAccepted: false, reopenedMarkers: 1 };
    boundary.rpc.mockResolvedValue({ data: { receipt: result, replayed: false }, error: null }); expect((await publishChanges(publication)).receipt.reopenedMarkers).toBe(1);
    boundary.rpc.mockResolvedValue({ data: { receipt: { ...result, reopenedMarkers: 2 }, replayed: false }, error: null }); await expect(publishChanges(publication)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
