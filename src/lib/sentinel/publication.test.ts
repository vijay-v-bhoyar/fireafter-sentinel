import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDocumentVersion } from "./evidence";
import { publishEvidence, SourceConfigurationSchema } from "./publication";

const boundary = vi.hoisted(() => ({ admin: vi.fn(), rpc: vi.fn() }));
vi.mock("../supabase", () => ({ getSupabaseAdminClient: () => boundary.admin() }));
const id = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { organizationId: id(1), incidentId: id(2), mode: "synthetic" as const };
const version = prepareDocumentVersion({ scope, documentId: id(3), sourceConfigRevision: id(4),
  issuer: "Synthetic county", jurisdiction: "Fixture county", canonicalUrl: "https://example.gov/notice", rawText: "Synthetic notice",
  publishedAt: null, effectiveFrom: null, effectiveUntil: null, availability: "available", contentPermission: "full_text" },
{ id: id(5), retrievedAt: "2026-10-11T10:00:00Z" }).version;
const command = { scope, runId: id(6), owner: id(7), fence: 1, commandId: id(8), observations: [{
  documentId: id(3), requestedAt: "2026-10-11T09:59:00Z", observedBytes: 16, providerRequestId: "fixture", outcome: "observed", version,
}] };
const result = { replayed: false, receipt: { commandId: command.commandId, runId: command.runId, scope, fence: 1,
  committedAt: "2026-10-11T10:01:00Z", evidenceGeneration: 1, unresolvedSourceChanges: 1, observations: [{
    documentId: id(3), eventId: id(20), versionId: version.id, previousVersionId: null, identityHash: version.identityHash,
    markerId: id(21), changed: true, outcome: "version",
  }] } };
beforeEach(() => {
  vi.resetAllMocks(); boundary.admin.mockReturnValue({ rpc: boundary.rpc }); boundary.rpc.mockResolvedValue({ data: result, error: null });
});
describe("Private worker evidence publication boundary", () => {
  it("sends only a strict scoped command through the guarded private client", async () => {
    expect(await publishEvidence(command)).toEqual(result);
    expect(boundary.rpc).toHaveBeenCalledExactlyOnceWith("sentinel_publish_evidence", { p_organization_id: scope.organizationId,
      p_incident_id: scope.incidentId, p_mode: scope.mode, p_run_id: command.runId, p_owner: command.owner,
      p_fence: command.fence, p_command_id: command.commandId, p_observations: command.observations });
  });
  it.each([
    { actorId: id(99) }, { fence: 0 }, { observations: [] }, { observations: Array(6).fill(command.observations[0]) },
    { observations: [command.observations[0], command.observations[0]] },
    { observations: [{ ...command.observations[0], documentId: id(99) }] },
    { observations: [{ ...command.observations[0], version: { ...version, normalizedText: "Corrupt" } }] },
    { observations: [{ ...command.observations[0], version: { ...version, scope: { ...scope, mode: "live" } } }] },
    { observations: [{ ...command.observations[0], requestedAt: "2026-10-11T10:02:00Z" }] },
  ])("rejects malformed, privileged or foreign input before client acquisition %j", async patch => {
    await expect(publishEvidence({ ...command, ...patch })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(boundary.admin).not.toHaveBeenCalled(); expect(boundary.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { runId: id(99) }, { commandId: id(99) }, { scope: { ...scope, incidentId: id(99) } }, { fence: 2 },
    { observations: [] }, { observations: [{ ...result.receipt.observations[0], identityHash: "f".repeat(64) }] },
    { observations: [{ ...result.receipt.observations[0], markerId: null }] },
    { observations: [{ ...result.receipt.observations[0], outcome: "failed" }] },
  ])("withholds corrupt or misbound receipts %j", async patch => {
    boundary.rpc.mockResolvedValue({ data: { ...result, receipt: { ...result.receipt, ...patch } }, error: null });
    await expect(publishEvidence(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("allows a historical receipt from an earlier fence on an authorized takeover replay", async () => {
    boundary.rpc.mockResolvedValue({ data: { ...result, replayed: true }, error: null });
    expect((await publishEvidence({ ...command, fence: 2 })).receipt.fence).toBe(1);
  });
  it("rejects a supposedly historical receipt from a future fence", async () => {
    boundary.rpc.mockResolvedValue({ data: { ...result, replayed: true, receipt: { ...result.receipt, fence: 2 } }, error: null });
    await expect(publishEvidence(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("records unavailable acquisition without accepting a version or marker", async () => {
    const unavailable = { documentId: id(3), requestedAt: command.observations[0].requestedAt, observedBytes: 0,
      providerRequestId: null, outcome: "failed", safeErrorCode: "SOURCE_UNAVAILABLE" };
    boundary.rpc.mockResolvedValue({ data: { ...result, receipt: { ...result.receipt, observations: [{
      ...result.receipt.observations[0], versionId: null, identityHash: null, changed: false, markerId: null, outcome: "failed",
    }] } }, error: null });
    expect((await publishEvidence({ ...command, observations: [unavailable] })).receipt.observations[0].versionId).toBeNull();
  });
  it.each([["42501", "SCOPE_DENIED"], ["22023", "INPUT_INVALID"], ["40001", "RUN_CONFLICT"], ["23505", "RUN_CONFLICT"], ["XX000", "STORAGE_UNAVAILABLE"]])(
    "maps SQLSTATE %s without leaking private diagnostics", async (code, expected) => {
      boundary.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_SOURCE_OR_CONNECTION" } });
      await expect(publishEvidence(command)).rejects.toMatchObject({ code: expected });
      await expect(publishEvidence(command)).rejects.not.toThrow("PRIVATE_SOURCE_OR_CONNECTION");
    });
  it("fails closed when target/client admission is unavailable", async () => {
    boundary.admin.mockImplementation(() => { throw new Error("SECRET_TARGET"); });
    await expect(publishEvidence(command)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" }); expect(boundary.rpc).not.toHaveBeenCalled();
  });
});
describe("Bounded immutable source registry contract", () => {
  const source = { documentId: id(3), documentKey: "fixture", canonicalUrl: version.canonicalUrl,
    issuer: version.issuer, jurisdiction: version.jurisdiction, contentPermission: "full_text" };
  it("accepts a scoped operator-provided public source configuration", () => {
    expect(SourceConfigurationSchema.parse({ schemaVersion: 1, sources: [source] }).sources).toHaveLength(1);
  });
  it.each(["documentId", "documentKey", "canonicalUrl"])("rejects duplicate %s identities", field => {
    const other = { ...source, documentId: id(99), documentKey: "other", canonicalUrl: "https://example.gov/other", [field]: source[field as keyof typeof source] };
    expect(SourceConfigurationSchema.safeParse({ schemaVersion: 1, sources: [source, other] }).success).toBe(false);
  });
  it.each(["http://example.gov/notice", "https://127.0.0.1/x", "https://user:password@example.gov/x"])("rejects disallowed URL %s", canonicalUrl => {
    expect(SourceConfigurationSchema.safeParse({ schemaVersion: 1, sources: [{ ...source, canonicalUrl }] }).success).toBe(false);
  });
});
