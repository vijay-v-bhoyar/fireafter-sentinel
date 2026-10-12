import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordClaimReview, readClaimReview } from "./claim-reviews";
const boundary = vi.hoisted(() => ({ admin: vi.fn(), rpc: vi.fn(), user: vi.fn() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
vi.mock("../auth", () => ({ getCurrentUser: () => boundary.user() }));
const id = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const }, actor = id(9);
const c = { incidentId: scope.incidentId, mode: scope.mode, claimId: id(3), commandId: id(4), expectedEvidenceGeneration: 2, expectedReviewId: null,
  support: "supported", applicability: "applicable", provenance: "verified", conflict: "clear", note: "Synthetic judgment" };
const review = { id: id(5), scope, claimId: c.claimId, actorId: actor, receiptId: id(6), createdAt: "2026-10-11T10:00:00.000Z",
  support: c.support, applicability: c.applicability, provenance: c.provenance, conflict: c.conflict, note: c.note };
const receipt = { id: id(6), commandId: c.commandId, claimId: c.claimId, reviewId: review.id, previousReviewId: null, scope, actorId: actor,
  committedAt: review.createdAt, evidenceGeneration: 3, unresolvedSourceChanges: 1 };
const projection = { scope, claimId: c.claimId, documentVersionId: id(7), evidenceGeneration: 3, unresolvedSourceChanges: 1,
  currentEvidence: true, observedAt: review.createdAt, review, receipt };
beforeEach(() => { vi.resetAllMocks(); boundary.admin.mockReturnValue({ rpc: boundary.rpc }); boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "analyst" });
  boundary.rpc.mockResolvedValue({ data: { review, receipt, replayed: false }, error: null }); });
describe("Claim review service boundary", () => {
  it.each([{ actorId: actor }, { role: "incident_commander" }, { scope }, { expectedReviewId: undefined }, { note: "\0" }, { note: "\ud800" },
    { note: "x".repeat(2001) }, { expectedEvidenceGeneration: Number.MAX_SAFE_INTEGER }, { support: "approved" }, { mode: "fixture" }])("rejects invalid/authority-owned input %j before authentication or storage", async patch => {
    await expect(recordClaimReview({ ...c, ...patch })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(boundary.user).not.toHaveBeenCalled(); expect(boundary.admin).not.toHaveBeenCalled();
  });
  it("derives committing identity from authentication", async () => {
    expect(await recordClaimReview(c)).toEqual({ review, receipt, replayed: false });
    expect(boundary.rpc).toHaveBeenCalledWith("sentinel_record_claim_review", { p_actor_id: actor, p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_claim_id: c.claimId, p_command_id: c.commandId,
      p_review: { expectedEvidenceGeneration: 2, expectedReviewId: null, support: c.support, applicability: c.applicability, provenance: c.provenance, conflict: c.conflict, note: c.note } });
  });
  it.each(["id", "commandId", "claimId", "reviewId", "previousReviewId", "scope", "actorId", "committedAt", "evidenceGeneration"])("rejects misbound receipt %s", async key => {
    const changed = structuredClone(receipt) as Record<string, unknown>;
    changed[key] = key === "scope" ? { ...scope, mode: "replay" } : key === "committedAt" ? "2026-10-11T11:00:00.000Z" : key === "evidenceGeneration" ? 4 : id(700);
    boundary.rpc.mockResolvedValue({ data: { review, receipt: changed, replayed: false }, error: null });
    await expect(recordClaimReview(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it.each(["support", "applicability", "provenance", "conflict", "note"])("rejects changed review content %s", async key => {
    const changed = structuredClone(review) as Record<string, unknown>; changed[key] = key === "support" ? "unsupported" : key === "applicability" ? "not_applicable" : key === "note" ? "Other" : "unresolved";
    boundary.rpc.mockResolvedValue({ data: { review: changed, receipt, replayed: false }, error: null });
    await expect(recordClaimReview(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it.each([["42501", "SCOPE_DENIED"], ["22023", "INPUT_INVALID"], ["40001", "REVIEW_CONFLICT"], ["23505", "REVIEW_CONFLICT"], ["XX000", "STORAGE_UNAVAILABLE"]])("maps SQL %s without private diagnostics", async (code, expected) => {
    boundary.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_SQL_DETAILS" } });
    await expect(recordClaimReview(c)).rejects.toMatchObject({ code: expected });
    try { await recordClaimReview(c); } catch (error) { expect(String(error)).not.toContain("PRIVATE_SQL_DETAILS"); }
  });
  it("handles authentication, viewer write denial and storage outages", async () => {
    boundary.user.mockResolvedValue(null); await expect(recordClaimReview(c)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "viewer" }); await expect(recordClaimReview(c)).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    boundary.user.mockRejectedValue(new Error("PRIVATE_AUTH")); await expect(recordClaimReview(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    boundary.user.mockResolvedValue({ id: actor, organizationId: scope.organizationId, role: "analyst" }); boundary.admin.mockReturnValue(null);
    await expect(recordClaimReview(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("reads a bound projection without supplying browser scope authority", async () => {
    boundary.rpc.mockResolvedValue({ data: projection, error: null }); expect(await readClaimReview(c.incidentId, c.mode, c.claimId)).toEqual(projection);
    expect(boundary.rpc).toHaveBeenCalledWith("sentinel_read_claim_review", { p_actor_id: actor, p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_claim_id: c.claimId });
  });
  it.each(["scope", "claimId", "reviewPair", "receiptPair", "generation", "authority"])("rejects corrupted projection %s", async key => {
    const p = structuredClone(projection) as Record<string, unknown>;
    if (key === "scope") p.scope = { ...scope, incidentId: id(700) };
    else if (key === "claimId") p.claimId = id(700);
    else if (key === "reviewPair") p.review = null;
    else if (key === "receiptPair") p.receipt = null;
    else if (key === "generation") p.evidenceGeneration = 1;
    else p.planApproved = true;
    boundary.rpc.mockResolvedValue({ data: p, error: null }); await expect(readClaimReview(c.incidentId, c.mode, c.claimId)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});

it("rejects a stored feedback projection attached to a different source version",async()=>{
 const feedback={id:id(20),scope,claimId:c.claimId,documentVersionId:id(99),runId:id(21),modelVersion:"synthetic",promptVersion:"synthetic",policyRevisionId:null,
 originalClaimHash:"a".repeat(64),correctedClaimText:"Synthetic correction",correctedClaimId:null,reasonCode:"other",reviewKind:"claim",claimReviewId:review.id,reviewDecisionId:null,
 receiptId:receipt.id,actorId:actor,createdAt:review.createdAt,permissionRecordId:null};
 boundary.rpc.mockResolvedValue({data:{...projection,feedback},error:null});await expect(readClaimReview(c.incidentId,c.mode,c.claimId)).rejects.toMatchObject({code:"STORAGE_UNAVAILABLE"});
});
