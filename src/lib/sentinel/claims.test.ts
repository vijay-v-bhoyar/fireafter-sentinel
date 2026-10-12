import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimPublicationSchema, publishClaims, readClaimPage } from "./claims";
import { evidenceHash } from "./evidence";
const boundary = vi.hoisted(() => ({ admin: vi.fn(), rpc: vi.fn(), user: vi.fn() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
vi.mock("../auth", () => ({ getCurrentUser: () => boundary.user() }));
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const draft = { id: id(20), documentVersionId: id(5), excerptStart: 0, excerptEnd: 6, excerpt: "Notice", excerptHash: evidenceHash("Notice"),
  kind: "general_notice", claimText: "Synthetic notice", entityIds: [], modelVersion: "synthetic-v1", promptVersion: "fixture-v1" };
const c = { scope, runId: id(6), owner: id(7), fence: 2, commandId: id(8), expectedEvidenceGeneration: 3, versionIds: [id(5)], claims: [draft] };
const receipt = { commandId: c.commandId, runId: c.runId, scope, fence: 2, committedAt: "2026-10-11T10:00:00.000Z",
  evidenceGeneration: 3, unresolvedSourceChanges: 1, versionIds: [id(5)], claimIds: [id(20)], semanticSupport: "unreviewed" };
const page = { scope, versionId: id(5), evidenceGeneration: 3, unresolvedSourceChanges: 1, currentEvidence: true, observedAt: receipt.committedAt,
  items: [{ sequence: 1, claim: { ...draft, scope, runId: id(6), createdAt: receipt.committedAt }, citationVerified: true, semanticSupport: "unreviewed" }],
  hasMore: false, nextAfterSequence: null };
beforeEach(() => { vi.clearAllMocks(); boundary.admin.mockReturnValue({ rpc: boundary.rpc }); boundary.user.mockResolvedValue({ id: id(9), organizationId: scope.organizationId, role: "analyst" }); });
describe("Private claim commands and projections reject unsafe boundary data", () => {
  it("forwards strict bounded worker input and verifies the full receipt binding", async () => {
    boundary.rpc.mockResolvedValue({ data: { receipt, replayed: false }, error: null });
    expect((await publishClaims(c)).receipt).toEqual(receipt);
    expect(boundary.rpc).toHaveBeenCalledWith("sentinel_publish_claims", expect.objectContaining({ p_claims: [draft], p_transient_texts: {}, p_expected_generation: 3 }));
  });
  it.each([
    { ...c, actorId: id(9) }, { ...c, supported: true }, { ...c, versionIds: [id(5), id(5)] },
    { ...c, claims: [draft, draft] }, { ...c, claims: [{ ...draft, entityIds: [id(9), id(9)] }] },
    { ...c, claims: [{ ...draft, excerptHash: "f".repeat(64) }] },
    { ...c, claims: [{ ...draft, documentVersionId: id(99) }] },
    { ...c, transientTexts: { [id(99)]: "Private text" } },
    { ...c, claims: [{ ...draft, excerpt: "\ud800" }] },
    { ...c, claims: [{ ...draft, claimText: "\0" }] },
    { ...c, claims: Array.from({ length: 26 }, (_, i) => ({ ...draft, id: id(100 + i) })) },
    { ...c, expectedEvidenceGeneration: -1 },
  ])("rejects invalid worker input before acquiring a client", async bad => {
    await expect(publishClaims(bad)).rejects.toMatchObject({ code: "INPUT_INVALID" }); expect(boundary.admin).not.toHaveBeenCalled();
  });
  it("bounds serialized mutation bytes even when control characters inflate transport", () => {
    const excerpt = "\t".repeat(70_000);
    expect(ClaimPublicationSchema.safeParse({ ...c, claims: [{ ...draft, excerpt, excerptEnd: excerpt.length, excerptHash: evidenceHash(excerpt) }] }).success).toBe(false);
  });
  it.each(["commandId", "runId", "scope", "fence", "evidenceGeneration", "versionIds", "claimIds", "semanticSupport"])("rejects misbound receipt %s", async key => {
    const r = structuredClone(receipt) as Record<string, unknown>;
    r[key] = key === "scope" ? { ...scope, incidentId: id(99) } : ["fence", "evidenceGeneration"].includes(key) ? 99
      : key.endsWith("Ids") ? [id(99)] : key === "semanticSupport" ? "supported" : id(99);
    boundary.rpc.mockResolvedValue({ data: { receipt: r, replayed: false }, error: null });
    await expect(publishClaims(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it.each([["42501", "SCOPE_DENIED"], ["22023", "INPUT_INVALID"], ["40001", "RUN_CONFLICT"], ["23505", "RUN_CONFLICT"], ["XX000", "STORAGE_UNAVAILABLE"]])("maps SQL %s safely", async (code, expected) => {
    boundary.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_DATABASE_DETAIL" } });
    await expect(publishClaims(c)).rejects.toMatchObject({ code: expected });
    try { await publishClaims(c); } catch (error) { expect(String(error)).not.toContain("PRIVATE_DATABASE_DETAIL"); }
  });
  it("unconfigured storage and authentication outages have no fabricated results", async () => {
    boundary.admin.mockReturnValue(null); await expect(publishClaims(c)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    boundary.user.mockResolvedValue(null); await expect(readClaimPage(scope.incidentId, scope.mode, id(5))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    boundary.user.mockRejectedValue(new Error("PRIVATE_AUTH_DETAIL")); await expect(readClaimPage(scope.incidentId, scope.mode, id(5))).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("member reader derives scope and actor from authentication", async () => {
    boundary.rpc.mockResolvedValue({ data: page, error: null });
    expect(await readClaimPage(scope.incidentId, scope.mode, id(5))).toEqual(page);
    expect(boundary.rpc).toHaveBeenCalledWith("sentinel_read_claims", { p_actor_id: id(9), p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_version_id: id(5), p_after_sequence: 0 });
  });
  it.each(["scope", "version", "quote", "position", "semantic", "cursor"])("rejects corrupted projection %s", async field => {
    const p = structuredClone(page);
    if (field === "scope") p.items[0].claim.scope.incidentId = id(99);
    if (field === "version") p.items[0].claim.documentVersionId = id(99);
    if (field === "quote") p.items[0].claim.excerpt = "Changed";
    if (field === "position") p.items[0].sequence = 0;
    if (field === "semantic") (p.items[0] as Record<string, unknown>).semanticSupport = "supported";
    if (field === "cursor") (p as Record<string, unknown>).nextAfterSequence = 1;
    boundary.rpc.mockResolvedValue({ data: p, error: null });
    await expect(readClaimPage(scope.incidentId, scope.mode, id(5))).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
